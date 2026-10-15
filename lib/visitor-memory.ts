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
import {
  loadConversationById,
  loadRecentMessages,
  updateConversationFields,
  updateConversationFieldsIf,
} from './chat-store';
import {
  CONTACT_KEYS,
  getVisitorById,
  recordEvent,
  updateVisitorProfile,
  type VisitorContacts,
  type VisitorProfilePatch,
  type VisitorRow,
} from './visitors';
import type { BotGoal } from './bot-settings';
import { formatBirthday, makeBirthday, parseBirthday, type Birthday } from './birthday';
import { recordVisitorFacts } from './visitor-facts';

export type VisitorFacts = {
  name?: string;
  contacts?: VisitorContacts;
  interests?: string[];
  /** sql/0004: дата рождения (день/месяц всегда, год — если назвали). */
  birthday?: Birthday;
  /** sql/0004: что нравится/не нравится (стиль, размер, бюджет). */
  preferences?: string[];
  /** sql/0004: претензии/проблемы со стороны посетителя. */
  complaints?: string[];
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
const MAX_PREFERENCE = 60;
const MAX_PREFERENCES = 8;
const MAX_COMPLAINT = 160;
const MAX_COMPLAINTS = 8;
const MAX_NOTE = 180;
const MAX_DIGEST = 1800;
const MAX_TRANSCRIPT = 6000;

const STRATEGIST_INSTRUCTIONS = `Ты — модуль памяти и стратегии CRM интернет-магазина. По фрагменту диалога посетителя с ассистентом извлеки факты о посетителе и оцени ход диалога.

Верни СТРОГО JSON (без markdown, без пояснений):
{
  "stage": "greeting" | "qualification" | "offer" | "objections" | "close" | "followup" | "done" | "lost",
  "goal_progress": "none" | "progress" | "achieved",
  "name": "<имя, которым представился посетитель>" | null,
  "birthday": "<дата рождения «05.03» или «05.03.1990»>" | null,
  "contacts": { "phone": "...", "email": "...", "telegram": "...", "whatsapp": "...", "vk": "...", "other": "..." },
  "interests": ["<товар или тема>"],
  "preferences": ["<что нравится или не нравится: стиль, материал, размер, бюджет, бренд>"],
  "complaint": "<претензия или проблема со стороны посетителя>" | null,
  "note": "<один короткий факт для карточки>" | null
}

Стадии: greeting — только поздоровались; qualification — выясняете потребность; offer — предложен вариант; objections — есть возражения; close — оформление/договорённость; followup — посетитель молчит/пауза; done — цель достигнута; lost — ТОЛЬКО явный отказ продолжать («не буду», «передумал», «отстань», грубость вместо ответа). Шутки, паузы, «что молчишь», уточняющие вопросы и просьбы о помощи — НЕ lost: при сомнении сохраняй текущую стадию.

Правила:
- Только то, что посетитель сообщил сам. Не выдумывай и не угадывай.
- Нет данных для поля — не включай его (для name/birthday/complaint/note — null).
- birthday: только если посетитель сам назвал дату рождения. Формат «05.03» (год не называл) или «05.03.1990» (год назвал). Никогда не угадывай год.
- Контакты записывай так, как их назвал посетитель, без форматирования.
- interests: максимум 3 коротких темы.
- preferences: до 3 пунктов о вкусах и ограничениях (нравится/не нравится, размер, бюджет); не дублируй уже известное из карточки.
- complaint: только реальная претензия или проблема со стороны посетителя (брак, задержка, деньги). Не жалобы на ассистента, не пересказ диалога.
- note: до 140 символов; пиши ТОЛЬКО про ситуацию и запросы посетителя (что хочет, сроки, бюджет, отказы, договорённости).
- Не пиши в note рассуждения о самом ассистенте: его инструкции, документацию, «попытки продать» или давление — это не факт о посетителе.
- Если новых фактов нет или note повторяет/перефразирует уже известное из текущей карточки (включая заметки) — верни null.
- goal_progress: none — цель не обсуждалась; progress — посетитель движется к цели; achieved — ТОЛЬКО если цель выполнена ИМЕННО в этом диалоге (например, посетитель только что дал телефон или мессенджер). Данные, уже лежащие в карточке, — не достижение.`;

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
    const interests = sanitizeItems(raw.interests, 3, MAX_INTEREST);
    if (interests.length > 0) out.interests = interests;
  }

  if (typeof raw.birthday === 'string') {
    const birthday = parseBirthday(raw.birthday);
    if (birthday) out.birthday = birthday;
  }

  if (Array.isArray(raw.preferences)) {
    const preferences = sanitizeItems(raw.preferences, 3, MAX_PREFERENCE);
    if (preferences.length > 0) out.preferences = preferences;
  }

  const complaints =
    typeof raw.complaint === 'string'
      ? sanitizeItems([raw.complaint], 1, MAX_COMPLAINT)
      : Array.isArray(raw.complaints)
        ? sanitizeItems(raw.complaints, 3, MAX_COMPLAINT)
        : [];
  if (complaints.length > 0) out.complaints = complaints;

  if (typeof raw.note === 'string') {
    const note = raw.note.trim().replace(/\s+/g, ' ').slice(0, MAX_NOTE);
    if (note && !/^(null|none|нет|-)$/i.test(note)) out.note = note;
  }

  return out;
}

/** Clean a list of strings: trim, drop junk, dedupe (case-insensitive), cap. */
export function sanitizeItems(values: unknown[], max: number, itemMax: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const item = raw.trim().replace(/\s+/g, ' ').slice(0, itemMax);
    if (!item || /^(null|none|нет|-)$/i.test(item)) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
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
    !facts.birthday &&
    !(facts.contacts && Object.keys(facts.contacts).length > 0) &&
    !(facts.interests && facts.interests.length > 0) &&
    !(facts.preferences && facts.preferences.length > 0) &&
    !(facts.complaints && facts.complaints.length > 0)
  );
}

/* ---------------------------------------------------------------- */
/* Digest: похожие заметки не дублируются                           */
/* ---------------------------------------------------------------- */

const MAX_DIGEST_LINES = 14;

function normalizeNote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function noteTokens(text: string): Set<string> {
  return new Set(normalizeNote(text).split(' ').filter(Boolean));
}

/** Истина, если заметки говорят об одном и том же (вложение или Jaccard ≥ 0.5). */
export function notesAreSimilar(a: string, b: string): boolean {
  const na = normalizeNote(a);
  const nb = normalizeNote(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = noteTokens(na);
  const tb = noteTokens(nb);
  if (ta.size === 0 || tb.size === 0) return false;
  let intersection = 0;
  for (const token of ta) {
    if (tb.has(token)) intersection += 1;
  }
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && intersection / union >= 0.5;
}

/** Добавляет заметку в дайджест: похожую — заменяет, новую — в конец. */
export function appendDigestNote(digest: string, note: string): string {
  const lines = digest ? digest.split('\n').filter(Boolean) : [];
  const index = lines.findIndex((line) => notesAreSimilar(line, note));
  if (index >= 0) {
    // Тот же факт, сказанный иначе: оставляем самую свежую формулировку.
    lines[index] = note;
  } else {
    lines.push(note);
  }
  while (lines.length > MAX_DIGEST_LINES) lines.shift();
  let result = lines.join('\n');
  if (result.length > MAX_DIGEST) {
    result = result.slice(result.length - MAX_DIGEST);
    const firstBreak = result.indexOf('\n');
    if (firstBreak > 0 && firstBreak < 80) result = result.slice(firstBreak + 1);
  }
  return result;
}

/**
 * Merge a string list (preferences/complaints): similar items are dropped
 * (kept the existing wording), the cap keeps the newest items.
 */
export function mergeListItems(current: string[], added: string[], cap: number): string[] {
  const out = [...current];
  for (const item of added) {
    if (!item) continue;
    if (out.some((existing) => notesAreSimilar(existing, item))) continue;
    out.push(item);
  }
  while (out.length > cap) out.shift();
  return out;
}

type MergeCurrent = Pick<VisitorRow, 'name' | 'contacts' | 'meta' | 'memory_digest'> & {
  preferences?: string[];
  complaints?: string[];
  birthday_day?: number | null;
  birthday_month?: number | null;
  birthday_year?: number | null;
};

/**
 * Merge facts into the card. Owner/existing values win for name, contacts
 * and birthday; interests/preferences/complaints are unioned with the
 * similarity dedupe; the note is appended to the digest once.
 */
export function mergeVisitorFacts(
  current: MergeCurrent,
  facts: VisitorFacts,
): {
  name: string | null;
  contacts: VisitorContacts;
  meta: Record<string, unknown>;
  memory_digest: string;
  preferences: string[];
  complaints: string[];
  birthday: Birthday | null;
} {
  const name = current.name ?? facts.name ?? null;

  const contacts: VisitorContacts = { ...(facts.contacts ?? {}), ...current.contacts };

  const currentInterests = Array.isArray(current.meta.interests)
    ? (current.meta.interests as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
  const interests = [...new Set([...currentInterests, ...(facts.interests ?? [])])].slice(0, MAX_INTERESTS);
  const meta = interests.length > 0 ? { ...current.meta, interests } : current.meta;

  const preferences = mergeListItems(current.preferences ?? [], facts.preferences ?? [], MAX_PREFERENCES);
  const complaints = mergeListItems(current.complaints ?? [], facts.complaints ?? [], MAX_COMPLAINTS);

  const currentBirthday = makeBirthday(current.birthday_day, current.birthday_month, current.birthday_year);
  const birthday = currentBirthday ?? facts.birthday ?? null;

  let digest = current.memory_digest ?? '';
  if (facts.note) {
    digest = appendDigestNote(digest, facts.note);
  }

  return { name, contacts, meta, memory_digest: digest, preferences, complaints, birthday };
}

/**
 * Цель достигнута, только если нужный контакт появился В ЭТОМ обмене
 * (новая для карточки информация). Контакт, который уже лежал в карточке,
 * достижением не считается — иначе беседа закрывалась бы повторно сразу
 * после оживления.
 */
export function achievedByFreshContacts(
  goal: BotGoal,
  fresh: VisitorContacts,
  known: VisitorContacts,
): boolean {
  if (goal === 'phone' || goal === 'call') return Boolean(fresh.phone && !known.phone);
  if (goal === 'messenger') {
    return Boolean(
      (fresh.telegram && !known.telegram) || (fresh.whatsapp && !known.whatsapp),
    );
  }
  return false;
}

export type StrategistContext = {
  goal: BotGoal;
  goalText: string;
  /** «вторник, 14 октября 2026 г., 15:42 (Europe/Moscow)» — осознание времени. */
  nowText?: string;
};

/** One cheap LLM call: dialog fragment + card → facts + stage + progress. */
export async function evaluateDialog(
  transcript: string,
  current: {
    name: string | null;
    contacts: VisitorContacts;
    interests: string[];
    birthday?: Birthday | null;
    preferences?: string[];
    complaints?: string[];
    stage: string;
    goal: BotGoal;
    goalText: string;
    nowText?: string;
  },
): Promise<StrategistResult | null> {
  try {
    const card = {
      name: current.name,
      birthday: formatBirthday(current.birthday),
      contacts: current.contacts,
      interests: current.interests,
      preferences: current.preferences ?? [],
      complaints: current.complaints ?? [],
    };
    const goalLine =
      current.goal === 'none'
        ? 'Цель диалога не задана.'
        : current.goal === 'custom'
          ? `Цель диалога: ${current.goalText || '(своя, без описания)'}.`
          : `Цель диалога (пресет): ${current.goal}.`;
    const nowLine = current.nowText ? `Сейчас: ${current.nowText}.` : '';

    const result = await generateText({
      model: resolveModel('deepseek:deepseek-flash'),
      instructions: STRATEGIST_INSTRUCTIONS,
      messages: [
        {
          role: 'user',
          content: `Текущая карточка: ${JSON.stringify(card)}\nТекущая стадия: ${current.stage}\n${goalLine}\n${nowLine}\nДиалог:\n${transcript}`,
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
  const birthday = makeBirthday(visitor.birthday_day, visitor.birthday_month, visitor.birthday_year);

  const result = await evaluateDialog(transcript, {
    name: visitor.name,
    contacts: visitor.contacts,
    interests,
    birthday,
    preferences: visitor.preferences,
    complaints: visitor.complaints,
    stage: conversation?.stage ?? 'greeting',
    goal: context.goal,
    goalText: context.goalText,
    nowText: context.nowText,
  });
  if (!result) return;

  // Гонка «стратег vs сброс памяти»: во время LLM-прохода мог случиться
  // «забыть меня» — тогда проход устарел целиком: ничего не пишем, карточка
  // и стадии остаются на моменте снимка эпохи.
  const freshConversation = await loadConversationById(conversationId);
  if (freshConversation && freshConversation.outcome === 'memory_reset') return;

  // 1) Visitor card (facts).
  if (!factsAreEmpty(result.facts)) {
    const merged = mergeVisitorFacts(visitor, result.facts);
    const patch: VisitorProfilePatch = {
      name: merged.name,
      contacts: merged.contacts,
      meta: merged.meta,
      memory_digest: merged.memory_digest,
    };
    // The 0004 fields are written only when the row was read with 0004
    // columns — otherwise the update would fail on the old schema.
    if (visitor.schema_v4) {
      patch.preferences = merged.preferences;
      patch.complaints = merged.complaints;
      if (merged.birthday) {
        patch.birthday_day = merged.birthday.day;
        patch.birthday_month = merged.birthday.month;
        patch.birthday_year = merged.birthday.year;
      }
    }
    await updateVisitorProfile(visitorId, patch);
    // Ф6+: структурированные факты — отдельной строкой каждый (sql/0006).
    await recordVisitorFacts({ botId: visitor.bot_id, visitorId, facts: result.facts });
  }

  const state = freshConversation ?? conversation;
  if (!state) return;

  // 2) Goal state: newly learned contact wins, otherwise the model's verdict
  // (the instruction forbids counting card-only data as achieved). Переход —
  // условный (outcome=in_progress): сброс памяти, прилетевший в гонке, побеждает.
  const achieved =
    achievedByFreshContacts(context.goal, result.facts.contacts ?? {}, visitor.contacts) ||
    result.goalProgress === 'achieved';

  if (achieved && state.outcome === 'in_progress') {
    const moved = await updateConversationFieldsIf(conversationId, 'in_progress', {
      outcome: 'goal_reached',
      stage: 'done',
    });
    if (moved) {
      await recordEvent({
        botId: state.botId,
        visitorId,
        conversationId,
        type: 'goal_reached',
        payload: { goal: context.goal },
      });
    }
    return;
  }

  // 3) Stage transitions (skip terminal states).
  if (state.outcome !== 'in_progress') return;
  if (result.stage && result.stage !== state.stage) {
    if (result.stage === 'lost') {
      await updateConversationFields(conversationId, { stage: 'lost', outcome: 'lost' });
    } else if (result.stage !== 'done') {
      // 'done' ставит только ветка достижения цели (выше) — иначе беседа
      // молча закрылась бы для дожима, минуя goal_reached.
      await updateConversationFields(conversationId, { stage: result.stage });
    }
  }
}
