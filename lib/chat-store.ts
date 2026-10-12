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
