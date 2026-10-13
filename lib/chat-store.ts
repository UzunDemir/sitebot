/**
 * Conversation persistence: session -> conversation row,
 * then user/assistant messages with usage and cost.
 */

import { getSupabase } from './supabase';

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
};

export async function saveAssistantMessage(
  conversationId: string,
  payload: AssistantMessagePayload,
): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      role: 'assistant',
      content: payload.content,
      citations: payload.citations,
      model: payload.model,
      input_tokens: payload.inputTokens,
      output_tokens: payload.outputTokens,
      cost_usd: payload.costUsd,
      latency_ms: payload.latencyMs,
    })
    .select('id')
    .single();
  if (error) throw error;
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
): Promise<{ messages: StoredMessage[]; hasMore: boolean }> {
  const supabase = getSupabase();
  // Fetch newest-first to enforce the window, then flip to chronological.
  const { data, error } = await supabase
    .from('messages')
    .select('id, role, content, citations, created_at')
    .eq('conversation_id', conversationId)
    .order('id', { ascending: false })
    .limit(limit + 1);
  if (error) throw error;

  const rows = (data ?? []) as Array<{
    id: number;
    role: string;
    content: string;
    citations: unknown;
    created_at: string;
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
