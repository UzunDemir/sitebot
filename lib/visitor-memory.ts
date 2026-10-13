/**
 * Visitor memory: extraction and merging of facts from the dialog.
 *
 * After each assistant answer the chat route schedules a best-effort
 * extraction (cheap model, JSON) that updates the visitor card: name,
 * contacts, interests, a short digest line. Any failure is ignored —
 * the dialog itself never depends on this layer.
 *
 * sanitizeVisitorFacts() and mergeVisitorFacts() are pure and unit-tested
 * in scripts/smoke-local.ts.
 */

import { generateText } from 'ai';
import { resolveModel } from './models';
import { loadRecentMessages } from './chat-store';
import {
  CONTACT_KEYS,
  getVisitorById,
  updateVisitorProfile,
  type VisitorContacts,
  type VisitorRow,
} from './visitors';

export type VisitorFacts = {
  name?: string;
  contacts?: VisitorContacts;
  interests?: string[];
  note?: string;
};

const MAX_NAME = 80;
const MAX_CONTACT = 120;
const MAX_INTEREST = 40;
const MAX_INTERESTS = 8;
const MAX_NOTE = 180;
const MAX_DIGEST = 1800;
const MAX_TRANSCRIPT = 6000;

const EXTRACT_INSTRUCTIONS = `Ты — модуль памяти CRM интернет-магазина. По фрагменту диалога посетителя с ассистентом извлеки факты о посетителе.

Верни СТРОГО JSON (без markdown, без пояснений):
{
  "name": "<имя, которым представился посетитель>" | null,
  "contacts": { "phone": "...", "email": "...", "telegram": "...", "whatsapp": "...", "vk": "...", "other": "..." },
  "interests": ["<товар или тема>"],
  "note": "<один короткий факт для карточки>" | null
}

Правила:
- Только то, что посетитель сообщил сам. Не выдумывай и не угадывай.
- Нет данных для поля — не включай его (для name/note — null).
- Контакты записывай так, как их назвал посетитель, без форматирования.
- interests: максимум 3 коротких темы.
- note: до 140 символов; только новый полезный факт (заказ, проблема, срок, пожелание); не повторяй факты из текущей карточки.`;

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

/** One cheap LLM call: dialog fragment + current card → new facts. */
export async function extractVisitorFacts(
  transcript: string,
  current: { name: string | null; contacts: VisitorContacts; interests: string[] },
): Promise<VisitorFacts | null> {
  try {
    const card = {
      name: current.name,
      contacts: current.contacts,
      interests: current.interests,
    };
    const result = await generateText({
      model: resolveModel('deepseek:deepseek-flash'),
      instructions: EXTRACT_INSTRUCTIONS,
      messages: [
        {
          role: 'user',
          content: `Текущая карточка: ${JSON.stringify(card)}\n\nДиалог:\n${transcript}`,
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
    return sanitizeVisitorFacts(JSON.parse(text.slice(start, end + 1)));
  } catch (err) {
    console.warn('[visitors] extraction failed:', err);
    return null;
  }
}

/** Read the tail of the dialog, extract facts and update the card. */
export async function refreshVisitorMemory(
  visitorId: string,
  conversationId: string,
): Promise<void> {
  const visitor = await getVisitorById(visitorId);
  if (!visitor) return;

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

  const facts = await extractVisitorFacts(transcript, {
    name: visitor.name,
    contacts: visitor.contacts,
    interests,
  });
  if (!facts || factsAreEmpty(facts)) return;

  const merged = mergeVisitorFacts(visitor, facts);
  await updateVisitorProfile(visitorId, {
    name: merged.name,
    contacts: merged.contacts,
    meta: merged.meta,
    memory_digest: merged.memory_digest,
  });
}
