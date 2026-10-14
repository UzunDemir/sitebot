/**
 * Visitor card storage (sql/0003_seller.sql + sql/0004_card.sql): identity,
 * extracted facts, owner notes, birthday, preferences, complaints.
 *
 * Everything here is best-effort and schema-aware: until 0003 is applied the
 * app keeps working (ensureVisitor returns null); until 0004 is applied the
 * extended fields fall back to empty values (`schema_v4 = false`), and
 * writers must NOT include 0004 columns in their patches.
 */

import { getSupabase } from './supabase';
import { isMissingColumnError } from './bot-settings';

export type VisitorContacts = Record<string, string>;

export type VisitorRow = {
  id: string;
  bot_id: string;
  visitor_key: string;
  name: string | null;
  contacts: VisitorContacts;
  tags: string[];
  notes: string;
  memory_digest: string;
  do_not_disturb: boolean;
  meta: Record<string, unknown>;
  first_seen: string;
  last_seen: string;
  /** sql/0004: день рождения (год может быть неизвестен). */
  birthday_day: number | null;
  birthday_month: number | null;
  birthday_year: number | null;
  /** sql/0004: предпочтения и претензии (авто + правка владельца). */
  preferences: string[];
  complaints: string[];
  /** true = строка прочитана с колонками 0004 (можно писать их в апдейтах). */
  schema_v4: boolean;
};

/** Keys allowed inside visitors.contacts (everything else is dropped). */
export const CONTACT_KEYS = ['phone', 'email', 'telegram', 'whatsapp', 'vk', 'instagram', 'other'] as const;

/** Columns of 0003. */
export const VISITOR_COLUMNS =
  'id, bot_id, visitor_key, name, contacts, tags, notes, memory_digest, do_not_disturb, meta, first_seen, last_seen';

/** Columns of 0003 + 0004 (used first; on a missing column we fall back). */
export const VISITOR_COLUMNS_V4 =
  VISITOR_COLUMNS + ', birthday_day, birthday_month, birthday_year, preferences, complaints';

/** True when PostgREST reports a missing table (sql/0003 not applied yet). */
export function isMissingRelationError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === '42P01' || code === 'PGRST205') return true;
  const message = (err as { message?: unknown }).message;
  return (
    typeof message === 'string' &&
    /relation .* does not exist|could not find the table|schema cache/i.test(message)
  );
}

function intOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

/** Normalize a raw DB row (jsonb/array columns may hold anything). */
export function parseVisitorRow(row: Record<string, unknown>, schemaV4 = false): VisitorRow {
  const contacts =
    row.contacts && typeof row.contacts === 'object' && !Array.isArray(row.contacts)
      ? (row.contacts as VisitorContacts)
      : {};
  const now = new Date().toISOString();
  return {
    id: String(row.id),
    bot_id: String(row.bot_id),
    visitor_key: String(row.visitor_key),
    name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null,
    contacts,
    tags: stringList(row.tags),
    notes: typeof row.notes === 'string' ? row.notes : '',
    memory_digest: typeof row.memory_digest === 'string' ? row.memory_digest : '',
    do_not_disturb: row.do_not_disturb === true,
    meta:
      row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)
        ? (row.meta as Record<string, unknown>)
        : {},
    first_seen: typeof row.first_seen === 'string' ? row.first_seen : now,
    last_seen: typeof row.last_seen === 'string' ? row.last_seen : now,
    birthday_day: intOrNull(row.birthday_day),
    birthday_month: intOrNull(row.birthday_month),
    birthday_year: intOrNull(row.birthday_year),
    preferences: stringList(row.preferences),
    complaints: stringList(row.complaints),
    schema_v4: schemaV4,
  };
}

/** Upsert the visitor row and return its id (null when the table is missing). */
export async function ensureVisitor(botId: string, visitorKey: string): Promise<string | null> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('visitors')
      .upsert(
        { bot_id: botId, visitor_key: visitorKey, last_seen: new Date().toISOString() },
        { onConflict: 'bot_id,visitor_key' },
      )
      .select('id')
      .single();
    if (error) {
      if (!isMissingRelationError(error)) console.warn('[visitors] ensure failed:', error.message);
      return null;
    }
    return (data?.id as string | undefined) ?? null;
  } catch (err) {
    console.warn('[visitors] ensure error:', err);
    return null;
  }
}

/** Upsert + full card read for one request (chat route memory block). */
export async function ensureVisitorRow(botId: string, visitorKey: string): Promise<VisitorRow | null> {
  const id = await ensureVisitor(botId, visitorKey);
  if (!id) return null;
  return getVisitorById(id);
}

/** Link a conversation to its visitor (first link wins, no-op afterwards). */
export async function attachConversationToVisitor(
  conversationId: string,
  visitorId: string,
): Promise<void> {
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from('conversations')
      .update({ visitor_id: visitorId })
      .eq('id', conversationId)
      .is('visitor_id', null);
    if (error && !isMissingRelationError(error)) {
      console.warn('[visitors] attach failed:', error.message);
    }
  } catch (err) {
    console.warn('[visitors] attach error:', err);
  }
}

export async function getVisitorById(visitorId: string): Promise<VisitorRow | null> {
  try {
    const supabase = getSupabase();
    let res = await supabase.from('visitors').select(VISITOR_COLUMNS_V4).eq('id', visitorId).maybeSingle();
    let schemaV4 = true;
    if (res.error && isMissingColumnError(res.error)) {
      res = await supabase.from('visitors').select(VISITOR_COLUMNS).eq('id', visitorId).maybeSingle();
      schemaV4 = false;
    }
    if (res.error) {
      if (!isMissingRelationError(res.error)) console.warn('[visitors] load failed:', res.error.message);
      return null;
    }
    return res.data ? parseVisitorRow(res.data as unknown as Record<string, unknown>, schemaV4) : null;
  } catch (err) {
    console.warn('[visitors] load error:', err);
    return null;
  }
}

export async function loadVisitorByKey(botId: string, visitorKey: string): Promise<VisitorRow | null> {
  try {
    const supabase = getSupabase();
    let res = await supabase
      .from('visitors')
      .select(VISITOR_COLUMNS_V4)
      .eq('bot_id', botId)
      .eq('visitor_key', visitorKey)
      .maybeSingle();
    let schemaV4 = true;
    if (res.error && isMissingColumnError(res.error)) {
      res = await supabase
        .from('visitors')
        .select(VISITOR_COLUMNS)
        .eq('bot_id', botId)
        .eq('visitor_key', visitorKey)
        .maybeSingle();
      schemaV4 = false;
    }
    if (res.error) {
      if (!isMissingRelationError(res.error)) console.warn('[visitors] load by key failed:', res.error.message);
      return null;
    }
    return res.data ? parseVisitorRow(res.data as unknown as Record<string, unknown>, schemaV4) : null;
  } catch (err) {
    console.warn('[visitors] load by key error:', err);
    return null;
  }
}

export type VisitorProfilePatch = Partial<
  Pick<
    VisitorRow,
    | 'name'
    | 'contacts'
    | 'tags'
    | 'notes'
    | 'memory_digest'
    | 'do_not_disturb'
    | 'meta'
    | 'birthday_day'
    | 'birthday_month'
    | 'birthday_year'
    | 'preferences'
    | 'complaints'
  >
>;

export async function updateVisitorProfile(
  visitorId: string,
  patch: VisitorProfilePatch,
): Promise<boolean> {
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from('visitors').update(patch).eq('id', visitorId);
    if (error) {
      if (!isMissingRelationError(error)) console.warn('[visitors] update failed:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[visitors] update error:', err);
    return false;
  }
}

/**
 * Best-effort funnel event (sql/0003): session_start, nudge_sent, stop_request…
 * Silently skipped when the events table is missing.
 */
export async function recordEvent(input: {
  botId: string;
  visitorId?: string | null;
  conversationId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  try {
    const supabase = getSupabase();
    const payload =
      input.payload && JSON.stringify(input.payload).length <= 2000 ? input.payload : {};
    const { error } = await supabase.from('events').insert({
      bot_id: input.botId,
      visitor_id: input.visitorId ?? null,
      conversation_id: input.conversationId ?? null,
      type: input.type,
      payload,
    });
    if (error && !isMissingRelationError(error)) {
      console.warn('[visitors] event failed:', error.message);
    }
  } catch (err) {
    console.warn('[visitors] event error:', err);
  }
}

/**
 * «Забыть меня»: removes the visitor card, their conversations (messages
 * cascade), events and purchases (0004). Idempotent, never throws.
 */
export async function deleteVisitorData(
  botId: string,
  visitorKey: string,
  sessionKey?: string,
): Promise<void> {
  try {
    const supabase = getSupabase();
    const visitor = await loadVisitorByKey(botId, visitorKey);

    // Current dialog (covers conversations created before the card existed).
    if (sessionKey) {
      const conv = await supabase
        .from('conversations')
        .delete()
        .eq('bot_id', botId)
        .eq('session_key', sessionKey);
      if (conv.error && !isMissingRelationError(conv.error)) {
        console.warn('[visitors] forget conversation failed:', conv.error.message);
      }
    }

    if (!visitor) return;

    const convs = await supabase.from('conversations').delete().eq('visitor_id', visitor.id);
    if (convs.error && !isMissingRelationError(convs.error)) {
      console.warn('[visitors] forget conversations failed:', convs.error.message);
    }
    const evts = await supabase.from('events').delete().eq('visitor_id', visitor.id);
    if (evts.error && !isMissingRelationError(evts.error)) {
      console.warn('[visitors] forget events failed:', evts.error.message);
    }
    const buys = await supabase.from('purchases').delete().eq('visitor_id', visitor.id);
    if (buys.error && !isMissingRelationError(buys.error)) {
      console.warn('[visitors] forget purchases failed:', buys.error.message);
    }
    const card = await supabase.from('visitors').delete().eq('id', visitor.id);
    if (card.error) console.warn('[visitors] forget card failed:', card.error.message);
  } catch (err) {
    console.warn('[visitors] forget error:', err);
  }
}
