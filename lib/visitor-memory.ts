/**
 * Dialog strategist + visitor memory (Ф3).
 *
 * After each assistant answer the chat route schedules a best-effort
 * evaluation (cheap model, JSON): facts about the visitor (name, contacts,
 * interests, a short digest line), the dialog stage and goal progress.
 * Failures are ignored — the dialog itself never depends on this layer.
 *
 * sanitizeVisitorFacts(), sanitizeStrategistResult() and mergeVisitorFacts()
 * are pure and unit-tested in scripts/smoke-local.ts.
 */

import { generateText } from 'ai';
import { resolveModel } from './models';
import { loadRecentMessages, updateConversationFields, loadConversationById } from './chat-store';
import {
  CONTACT_KEYS,
  getVisitorById,
  recordEvent,
  updateVisitorProfile,
  type VisitorContacts,
  type VisitorRow,
} from './visitors';
import type { BotGoal } from './bot-settings';

export type VisitorFacts = {
  name?: string;
  contacts?: VisitorContacts;
  interests?: string[];
  note?: string;
};

/** Dialog stages (stored in conversations.stage). */
export const STAGES = [
  'greeting',
  'qualification',
  'offer',
  'objections',
  'close',
  'followup',
  'done',
  'lost',
] as const;

export type StrategistResult = {
  facts: VisitorFacts;
  stage?: string;
  goalProgress?: 'none' | 'progress' | 'achieved';
};

const MAX_NAME = 80;
const MAX_CONTACT = 120;
const MAX_INTEREST = 40;
const MAX_INTERESTS = 8;
const MAX_NOTE = 180;
const MAX_DIGEST = 1800;
const MAX_TRANSCRIPT = 6000;

const STRATEGIST_INSTRUCTIONS = `Ты — модуль памяти и стратегии CRM интернет-магазина. По фрагменту диалога посетителя с ассистентом извлеки факты о посетителе и оцени ход диалога.

Верни СТРОГО JSON (без markdown, без пояснений):
{
  "stage": "greeting" | "qualification" | "offer" | "objections" | "close" | "followup" | "done" | "lost",
  "goal_progress": "none" | "progress" | "achieved",
  "name": "<имя, которым представился посетитель>" | null,
  "contacts": { "phone": "...", "email": "...", "telegram": "...", "whatsapp": "...", "vk": "...", "other": "..." },
  "interests": ["<товар или тема>"],
  "note": "<один короткий факт для карточки>" | null
}

Стадии: greeting — только поздоровались; qualification — выясняете потребность; offer — предложен вариант; objections — есть возражения; close — оформление/договорённость; followup — посетитель молчит/пауза; done — цель достигнута; lost — явный отказ.

Правила:
- Только то, что посетитель сообщил сам. Не выдумывай и не угадывай.
- Нет данных для поля — не включай его (для name/note — null).
- Контакты записывай так, как их назвал посетитель, без форматирования.
- interests: максимум 3 коротких темы.
- note: до 140 символов; только новый полезный факт (заказ, проблема, срок, пожелание); не повторяй факты из текущей карточки.
- goal_progress: none — цель не обсуждалась; progress — посетитель движется к цели; achieved — цель из условия уже выполнена по диалогу или карточке.`;

/** Validate model output: trim, cap, drop unknown contact keys and junk. */
export function sanitizeVisitorFacts(input: unknown): VisitorFacts {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const raw = input as Record<string, unknown>;
  const out: VisitorFacts = {};

  if (typeof raw.name === 'string') {
    const name = raw.name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
    if (name && !/^(null|none|нет|неизвестно|аноним)$/i.test(name)) out.name = name;
  }

  if (raw.contacts && typeof raw.contacts === 'object' && !Array.isArray(raw.contacts)) {
    const contacts: VisitorContacts = {};
    for (const [key, value] of Object.entries(raw.contacts as Record<string, unknown>)) {
      if (!(CONTACT_KEYS as readonly string[]).includes(key)) continue;
      if (typeof value !== 'string') continue;
      const v = value.trim().replace(/\s+/g, ' ').slice(0, MAX_CONTACT);
      if (v && !/^(null|none|нет|-)$/i.test(v)) contacts[key] = v;
    }
    if (Object.keys(contacts).length > 0) out.contacts = contacts;
  }

  if (Array.isArray(raw.interests)) {
    const interests = [
      ...new Set(
        raw.interests
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim().slice(0, MAX_INTEREST))
          .filter((item) => item && !/^(null|none|нет)$/i.test(item)),
      ),
    ].slice(0, 3);
    if (interests.length > 0) out.interests = interests;
  }

  if (typeof raw.note === 'string') {
    const note = raw.note.trim().replace(/\s+/g, ' ').slice(0, MAX_NOTE);
    if (note && !/^(null|none|нет|-)$/i.test(note)) out.note = note;
  }

  return out;
}

/** Full strategist output: facts + stage + goal progress. */
export function sanitizeStrategistResult(input: unknown): StrategistResult {
  const facts = sanitizeVisitorFacts(input);
  const out: StrategistResult = { facts };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  const raw = input as Record<string, unknown>;

  if (typeof raw.stage === 'string' && (STAGES as readonly string[]).includes(raw.stage)) {
    out.stage = raw.stage;
  }
  if (raw.goal_progress === 'achieved' || raw.goal_progress === 'progress' || raw.goal_progress === 'none') {
    out.goalProgress = raw.goal_progress;
  }
  return out;
}

export function factsAreEmpty(facts: VisitorFacts): boolean {
  return (
    !facts.name &&
    !facts.note &&
    !(facts.contacts && Object.keys(facts.contacts).length > 0) &&
    !(facts.interests && facts.interests.length > 0)
  );
}

/**
 * Merge facts into the card. Owner/existing values win for name and
 * contacts; interests are unioned; the note is appended to the digest once.
 */
export function mergeVisitorFacts(
  current: Pick<VisitorRow, 'name' | 'contacts' | 'meta' | 'memory_digest'>,
  facts: VisitorFacts,
): { name: string | null; contacts: VisitorContacts; meta: Record<string, unknown>; memory_digest: string } {
  const name = current.name ?? facts.name ?? null;

  const contacts: VisitorContacts = { ...(facts.contacts ?? {}), ...current.contacts };

  const currentInterests = Array.isArray(current.meta.interests)
    ? (current.meta.interests as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
  const interests = [...new Set([...currentInterests, ...(facts.interests ?? [])])].slice(0, MAX_INTERESTS);
  const meta = interests.length > 0 ? { ...current.meta, interests } : current.meta;

  let digest = current.memory_digest ?? '';
  if (facts.note && !digest.includes(facts.note)) {
    digest = digest ? `${digest}\n${facts.note}` : facts.note;
  }
  if (digest.length > MAX_DIGEST) {
    digest = digest.slice(digest.length - MAX_DIGEST);
    const firstBreak = digest.indexOf('\n');
    if (firstBreak > 0 && firstBreak < 80) digest = digest.slice(firstBreak + 1);
  }

  return { name, contacts, meta, memory_digest: digest };
}

/** Goals that are provably achieved by the visitor card itself. */
function goalReachedByFacts(goal: BotGoal, contacts: VisitorContacts): boolean {
  if (goal === 'phone' || goal === 'call') return Boolean(contacts.phone);
  if (goal === 'messenger') return Boolean(contacts.telegram || contacts.whatsapp);
  return false;
}

export type StrategistContext = {
  goal: BotGoal;
  goalText: string;
};

/** One cheap LLM call: dialog fragment + card → facts + stage + progress. */
export async function evaluateDialog(
  transcript: string,
  current: {
    name: string | null;
    contacts: VisitorContacts;
    interests: string[];
    stage: string;
    goal: BotGoal;
    goalText: string;
  },
): Promise<StrategistResult | null> {
  try {
    const card = {
      name: current.name,
      contacts: current.contacts,
      interests: current.interests,
    };
    const goalLine =
      current.goal === 'none'
        ? 'Цель диалога не задана.'
        : current.goal === 'custom'
          ? `Цель диалога: ${current.goalText || '(своя, без описания)'}.`
          : `Цель диалога (пресет): ${current.goal}.`;

    const result = await generateText({
      model: resolveModel('deepseek:deepseek-flash'),
      instructions: STRATEGIST_INSTRUCTIONS,
      messages: [
        {
          role: 'user',
          content: `Текущая карточка: ${JSON.stringify(card)}\nТекущая стадия: ${current.stage}\n${goalLine}\n\nДиалог:\n${transcript}`,
        },
      ],
      temperature: 0,
      maxOutputTokens: 400,
      providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
      abortSignal: AbortSignal.timeout(20_000),
    });

    const text = result.text ?? '';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    return sanitizeStrategistResult(JSON.parse(text.slice(start, end + 1)));
  } catch (err) {
    console.warn('[visitors] strategist call failed:', err);
    return null;
  }
}

/**
 * Background pass after a finished exchange: update the card, the dialog
 * stage and goal state; record the goal_reached event once.
 */
export async function runStrategist(
  visitorId: string,
  conversationId: string,
  context: StrategistContext,
): Promise<void> {
  const visitor = await getVisitorById(visitorId);
  if (!visitor) return;
  const conversation = await loadConversationById(conversationId);

  const { messages } = await loadRecentMessages(conversationId, 12);
  if (messages.length === 0) return;
  const transcript = messages
    .slice(-12)
    .map((message) => `${message.role === 'user' ? 'Посетитель' : 'Ассистент'}: ${message.content}`)
    .join('\n')
    .slice(-MAX_TRANSCRIPT);

  const interests = Array.isArray(visitor.meta.interests)
    ? (visitor.meta.interests as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];

  const result = await evaluateDialog(transcript, {
    name: visitor.name,
    contacts: visitor.contacts,
    interests,
    stage: conversation?.stage ?? 'greeting',
    goal: context.goal,
    goalText: context.goalText,
  });
  if (!result) return;

  // 1) Visitor card (facts).
  if (!factsAreEmpty(result.facts)) {
    const merged = mergeVisitorFacts(visitor, result.facts);
    await updateVisitorProfile(visitorId, {
      name: merged.name,
      contacts: merged.contacts,
      meta: merged.meta,
      memory_digest: merged.memory_digest,
    });
  }

  if (!conversation) return;

  // 2) Goal state: facts-based proof wins, otherwise the model's verdict.
  const contacts = result.facts.contacts
    ? { ...result.facts.contacts, ...visitor.contacts }
    : visitor.contacts;
  const achieved =
    goalReachedByFacts(context.goal, contacts) || result.goalProgress === 'achieved';

  if (achieved && conversation.outcome === 'in_progress') {
    await updateConversationFields(conversationId, { outcome: 'goal_reached', stage: 'done' });
    await recordEvent({
      botId: conversation.botId,
      visitorId,
      conversationId,
      type: 'goal_reached',
      payload: { goal: context.goal },
    });
    return;
  }

  // 3) Stage transitions (skip terminal states).
  if (conversation.outcome !== 'in_progress') return;
  if (result.stage && result.stage !== conversation.stage) {
    if (result.stage === 'lost') {
      await updateConversationFields(conversationId, { stage: 'lost', outcome: 'lost' });
    } else {
      await updateConversationFields(conversationId, { stage: result.stage });
    }
  }
}
