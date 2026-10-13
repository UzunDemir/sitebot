/**
 * Visitor card storage (sql/0003_seller.sql): identity, extracted facts,
 * owner notes and tags.
 *
 * Everything here is best-effort: until the migration is applied the app
 * keeps working — ensureVisitor() returns null and callers skip memory work.
 */

import { getSupabase } from './supabase';

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
};

/** Keys allowed inside visitors.contacts (everything else is dropped). */
export const CONTACT_KEYS = ['phone', 'email', 'telegram', 'whatsapp', 'vk', 'instagram', 'other'] as const;

export const VISITOR_COLUMNS =
  'id, bot_id, visitor_key, name, contacts, tags, notes, memory_digest, do_not_disturb, meta, first_seen, last_seen';

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

/** Normalize a raw DB row (jsonb/array columns may hold anything). */
export function parseVisitorRow(row: Record<string, unknown>): VisitorRow {
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
    tags: Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === 'string') : [],
    notes: typeof row.notes === 'string' ? row.notes : '',
    memory_digest: typeof row.memory_digest === 'string' ? row.memory_digest : '',
    do_not_disturb: row.do_not_disturb === true,
    meta:
      row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)
        ? (row.meta as Record<string, unknown>)
        : {},
    first_seen: typeof row.first_seen === 'string' ? row.first_seen : now,
    last_seen: typeof row.last_seen === 'string' ? row.last_seen : now,
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
    const { data, error } = await supabase
      .from('visitors')
      .select(VISITOR_COLUMNS)
      .eq('id', visitorId)
      .maybeSingle();
    if (error) {
      if (!isMissingRelationError(error)) console.warn('[visitors] load failed:', error.message);
      return null;
    }
    return data ? parseVisitorRow(data as Record<string, unknown>) : null;
  } catch (err) {
    console.warn('[visitors] load error:', err);
    return null;
  }
}

export async function loadVisitorByKey(botId: string, visitorKey: string): Promise<VisitorRow | null> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('visitors')
      .select(VISITOR_COLUMNS)
      .eq('bot_id', botId)
      .eq('visitor_key', visitorKey)
      .maybeSingle();
    if (error) {
      if (!isMissingRelationError(error)) console.warn('[visitors] load by key failed:', error.message);
      return null;
    }
    return data ? parseVisitorRow(data as Record<string, unknown>) : null;
  } catch (err) {
    console.warn('[visitors] load by key error:', err);
    return null;
  }
}

export type VisitorProfilePatch = Partial<
  Pick<VisitorRow, 'name' | 'contacts' | 'tags' | 'notes' | 'memory_digest' | 'do_not_disturb' | 'meta'>
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
 * «Забыть меня»: removes the visitor card, their conversations (messages
 * cascade) and events. Idempotent, never throws.
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
    const card = await supabase.from('visitors').delete().eq('id', visitor.id);
    if (card.error) console.warn('[visitors] forget card failed:', card.error.message);
  } catch (err) {
    console.warn('[visitors] forget error:', err);
  }
}
