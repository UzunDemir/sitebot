/**
 * Conversation persistence: session -> conversation row,
 * then user/assistant messages with usage and cost.
 */

import { getSupabase } from './supabase';
import { isMissingColumnError } from './bot-settings';

export async function ensureConversation(botId: string, sessionKey: string): Promise<string> {
  const supabase = getSupabase();

  const { data: existing, error: selectError } = await supabase
    .from('conversations')
    .select('id')
    .eq('bot_id', botId)
    .eq('session_key', sessionKey)
    .maybeSingle();
  if (selectError) throw selectError;

  if (existing) {
    await supabase
      .from('conversations')
      .update({ last_active_at: new Date().toISOString() })
      .eq('id', existing.id);
    return existing.id as string;
  }

  const { data: created, error: insertError } = await supabase
    .from('conversations')
    .insert({ bot_id: botId, session_key: sessionKey })
    .select('id')
    .single();

  if (insertError) {
    // Concurrent insert race: re-select.
    const { data: retry, error: retryError } = await supabase
      .from('conversations')
      .select('id')
      .eq('bot_id', botId)
      .eq('session_key', sessionKey)
      .maybeSingle();
    if (retryError || !retry) throw insertError;
    return retry.id as string;
  }

  return created.id as string;
}

export async function saveUserMessage(conversationId: string, content: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, role: 'user', content });
  if (error) throw error;
}

export type AssistantMessagePayload = {
  content: string;
  citations: Array<Record<string, unknown>>;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  /** Proactive touch (nudge) — needs sql/0003; degrades gracefully without it. */
  isProactive?: boolean;
  nudgeNumber?: number | null;
};

export async function saveAssistantMessage(
  conversationId: string,
  payload: AssistantMessagePayload,
): Promise<number> {
  const supabase = getSupabase();

  const build = (withProactive: boolean): Record<string, unknown> => {
    const row: Record<string, unknown> = {
      conversation_id: conversationId,
      role: 'assistant',
      content: payload.content,
      citations: payload.citations,
      model: payload.model,
      input_tokens: payload.inputTokens,
      output_tokens: payload.outputTokens,
      cost_usd: payload.costUsd,
      latency_ms: payload.latencyMs,
    };
    if (withProactive) {
      row.is_proactive = true;
      row.nudge_number = payload.nudgeNumber ?? null;
    }
    return row;
  };

  const wantsProactive = payload.isProactive === true;
  const { data, error } = await supabase
    .from('messages')
    .insert(build(wantsProactive))
    .select('id')
    .single();
  if (error) {
    // Old schema without sql/0003: retry without the proactive columns.
    if (wantsProactive && isMissingColumnError(error)) {
      const retry = await supabase.from('messages').insert(build(false)).select('id').single();
      if (retry.error) throw retry.error;
      return retry.data.id as number;
    }
    throw error;
  }
  return data.id as number;
}

/* ---------------------------------------------------------------- */
/* Read-side helpers (widget hydration: GET /api/chat/history)      */
/* ---------------------------------------------------------------- */

export type StoredMessage = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  citations: unknown;
  createdAt: string;
  /** Proactive touch (nudge), sql/0003; false on the legacy schema. */
  isProactive: boolean;
};

export async function getConversationId(botId: string, sessionKey: string): Promise<string | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('conversations')
    .select('id')
    .eq('bot_id', botId)
    .eq('session_key', sessionKey)
    .maybeSingle();
  if (error) throw error;
  return (data?.id as string | undefined) ?? null;
}

export async function loadRecentMessages(
  conversationId: string,
  limit: number,
  /** Активное окно памяти (sql/0005): только сообщения после этой границы. */
  since?: Date | null,
): Promise<{ messages: StoredMessage[]; hasMore: boolean }> {
  const supabase = getSupabase();
  const build = (columns: string) => {
    const query = supabase
      .from('messages')
      .select(columns)
      .eq('conversation_id', conversationId)
      .order('id', { ascending: false })
      .limit(limit + 1);
    return since ? query.gt('created_at', since.toISOString()) : query;
  };

  // Fetch newest-first to enforce the window, then flip to chronological.
  let result = await build('id, role, content, citations, created_at, is_proactive');
  if (result.error && isMissingColumnError(result.error)) {
    result = await build('id, role, content, citations, created_at');
  }
  if (result.error) throw result.error;

  const rows = (result.data ?? []) as unknown as Array<{
    id: number;
    role: string;
    content: string;
    citations: unknown;
    created_at: string;
    is_proactive?: boolean;
  }>;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    hasMore,
    messages: page.reverse().map((row) => ({
      id: row.id,
      role: row.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: row.content,
      citations: row.citations,
      createdAt: row.created_at,
      isProactive: row.is_proactive === true,
    })),
  };
}

export async function loadRatings(messageIds: number[]): Promise<Map<number, 1 | -1>> {
  const ratings = new Map<number, 1 | -1>();
  if (messageIds.length === 0) return ratings;

  const supabase = getSupabase();
  // Latest row wins: feedback has no unique constraint on message_id.
  const { data, error } = await supabase
    .from('feedback')
    .select('id, message_id, rating')
    .in('message_id', messageIds)
    .order('id', { ascending: false });
  if (error) throw error;

  for (const row of data ?? []) {
    const messageId = row.message_id as number;
    if (!ratings.has(messageId) && (row.rating === 1 || row.rating === -1)) {
      ratings.set(messageId, row.rating as 1 | -1);
    }
  }
  return ratings;
}

/* ---------------------------------------------------------------- */
/* Conversation state: stage, outcome, nudge counters (sql/0003)    */
/* ---------------------------------------------------------------- */

export type ConversationMeta = {
  id: string;
  botId: string;
  stage: string;
  outcome: string;
  nudgesSent: number;
  lastNudgeAt: string | null;
  visitorId: string | null;
};

function parseConversationMeta(row: Record<string, unknown>): ConversationMeta {
  return {
    id: String(row.id),
    botId: typeof row.bot_id === 'string' ? row.bot_id : '',
    stage: typeof row.stage === 'string' ? row.stage : 'greeting',
    outcome: typeof row.outcome === 'string' ? row.outcome : 'in_progress',
    nudgesSent: typeof row.nudges_sent === 'number' ? row.nudges_sent : 0,
    lastNudgeAt: typeof row.last_nudge_at === 'string' ? row.last_nudge_at : null,
    visitorId: typeof row.visitor_id === 'string' ? row.visitor_id : null,
  };
}

const CONVERSATION_META_COLUMNS = 'id, bot_id, stage, outcome, nudges_sent, last_nudge_at, visitor_id';
const CONVERSATION_META_LEGACY = 'id, bot_id';

export async function loadConversationById(conversationId: string): Promise<ConversationMeta | null> {
  const supabase = getSupabase();
  const full = await supabase
    .from('conversations')
    .select(CONVERSATION_META_COLUMNS)
    .eq('id', conversationId)
    .maybeSingle();
  if (full.error && isMissingColumnError(full.error)) {
    const bare = await supabase
      .from('conversations')
      .select(CONVERSATION_META_LEGACY)
      .eq('id', conversationId)
      .maybeSingle();
    if (bare.error) throw bare.error;
    return bare.data ? parseConversationMeta(bare.data as Record<string, unknown>) : null;
  }
  if (full.error) throw full.error;
  return full.data ? parseConversationMeta(full.data as Record<string, unknown>) : null;
}

export async function loadConversationByKey(
  botId: string,
  sessionKey: string,
): Promise<ConversationMeta | null> {
  const supabase = getSupabase();
  const full = await supabase
    .from('conversations')
    .select(CONVERSATION_META_COLUMNS)
    .eq('bot_id', botId)
    .eq('session_key', sessionKey)
    .maybeSingle();
  if (full.error && isMissingColumnError(full.error)) {
    const bare = await supabase
      .from('conversations')
      .select(CONVERSATION_META_LEGACY)
      .eq('bot_id', botId)
      .eq('session_key', sessionKey)
      .maybeSingle();
    if (bare.error) throw bare.error;
    return bare.data ? parseConversationMeta(bare.data as Record<string, unknown>) : null;
  }
  if (full.error) throw full.error;
  return full.data ? parseConversationMeta(full.data as Record<string, unknown>) : null;
}

export type ConversationPatch = {
  stage?: string;
  outcome?: string;
  nudges_sent?: number;
  last_nudge_at?: string | null;
  last_active_at?: string;
  summary?: string;
};

/** Best-effort conversation update; degrades on the pre-0003 schema. */
export async function updateConversationFields(
  conversationId: string,
  patch: ConversationPatch,
): Promise<void> {
  try {
    const supabase = getSupabase();
    const upd = await supabase.from('conversations').update(patch).eq('id', conversationId);
    if (upd.error && isMissingColumnError(upd.error)) {
      if (patch.last_active_at) {
        const fallback = await supabase
          .from('conversations')
          .update({ last_active_at: patch.last_active_at })
          .eq('id', conversationId);
        if (fallback.error) {
          console.warn('[chat-store] conversation update failed:', fallback.error.message);
        }
      }
      return;
    }
    if (upd.error) console.warn('[chat-store] conversation update failed:', upd.error.message);
  } catch (err) {
    console.warn('[chat-store] conversation update error:', err);
  }
}

/**
 * Условный переход состояния: пишем, только если outcome всё ещё равен
 * ожидаемому. Защищает от гонок («стратег vs сброс памяти»): устаревший
 * проход не оживит беседу, которую уже закрыл «забыть меня».
 * Возвращает true, если строка действительно обновилась.
 */
export async function updateConversationFieldsIf(
  conversationId: string,
  expectedOutcome: string,
  patch: ConversationPatch,
): Promise<boolean> {
  try {
    const supabase = getSupabase();
    const upd = await supabase
      .from('conversations')
      .update(patch)
      .eq('id', conversationId)
      .eq('outcome', expectedOutcome)
      .select('id');
    if (upd.error) {
      if (!isMissingColumnError(upd.error)) {
        console.warn('[chat-store] conditional update failed:', upd.error.message);
      }
      return false;
    }
    return Array.isArray(upd.data) && upd.data.length > 0;
  } catch (err) {
    console.warn('[chat-store] conditional update error:', err);
    return false;
  }
}
