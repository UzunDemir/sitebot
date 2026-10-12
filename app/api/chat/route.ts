/**
 * Chat endpoint.
 *
 * Pipeline: validate bot -> daily quota -> embed query -> hybrid search
 * (vector + FTS, RRF) -> grounded prompt -> streamText (DeepSeek) ->
 * UI message stream with `data-sources` and, after persistence,
 * `data-feedback` (the stored assistant message id for ratings).
 */

import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from 'ai';
import { getSupabase } from '@/lib/supabase';
import { resolveModel } from '@/lib/models';
import { hybridSearch } from '@/lib/retrieval';
import { buildSystemPrompt } from '@/lib/prompts';
import { ensureConversation, saveUserMessage, saveAssistantMessage } from '@/lib/chat-store';
import { estimateCostUsd } from '@/lib/pricing';

export const maxDuration = 60;

/** Demo-grade per-bot daily quota (chat requests). */
const DAILY_REQUEST_LIMIT = 300;

type ChatRequestBody = {
  messages?: UIMessage[];
  botKey?: string;
  sessionKey?: string;
};

type BotRow = {
  id: string;
  public_key: string;
  model_id: string;
  system_prompt: string;
  temperature: number;
  thinking_enabled: boolean;
  top_k: number;
};

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function messageText(message: UIMessage | undefined): string {
  if (!message) return '';
  return message.parts
    .map((part) => {
      const p = part as { type: string; text?: string };
      return p.type === 'text' ? p.text ?? '' : '';
    })
    .join('\n')
    .trim();
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Best-effort daily usage accounting (read-modify-write, demo-grade). */
async function bumpQuota(botId: string, requestsDelta: number, tokensDelta: number): Promise<void> {
  try {
    const supabase = getSupabase();
    const day = utcDay();
    const current = await supabase
      .from('quota_counters')
      .select('requests, tokens')
      .eq('bot_id', botId)
      .eq('day', day)
      .maybeSingle();
    if (current.error) {
      console.warn('[chat] quota read failed:', current.error.message);
      return;
    }
    const requests = (current.data?.requests ?? 0) + requestsDelta;
    const tokens = (current.data?.tokens ?? 0) + tokensDelta;
    const upd = await supabase
      .from('quota_counters')
      .upsert({ bot_id: botId, day, requests, tokens }, { onConflict: 'bot_id,day' });
    if (upd.error) console.warn('[chat] quota write failed:', upd.error.message);
  } catch (err) {
    console.warn('[chat] quota update failed:', err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as ChatRequestBody;
    const messages = body.messages ?? [];
    const sessionKey = body.sessionKey?.trim() ?? '';
    const startedAt = Date.now();

    // --- resolve bot
    const supabase = getSupabase();
    let bot: BotRow | null = null;

    if (body.botKey) {
      const { data, error } = await supabase
        .from('bots')
        .select('id, public_key, model_id, system_prompt, temperature, thinking_enabled, top_k')
        .eq('public_key', body.botKey)
        .eq('is_active', true)
        .maybeSingle();
      if (error) throw error;
      bot = data as BotRow | null;
    } else {
      const { data, error } = await supabase
        .from('bots')
        .select('id, public_key, model_id, system_prompt, temperature, thinking_enabled, top_k')
        .eq('is_active', true)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      bot = data as BotRow | null;
    }

    if (!bot) {
      return jsonError('Bot not found', 404);
    }

    // --- daily quota gate
    const quota = await supabase
      .from('quota_counters')
      .select('requests')
      .eq('bot_id', bot.id)
      .eq('day', utcDay())
      .maybeSingle();
    if (!quota.error && (quota.data?.requests ?? 0) >= DAILY_REQUEST_LIMIT) {
      return Response.json(
        {
          error: 'quota_exceeded',
          message: `Дневной лимит демо-бота исчерпан (${DAILY_REQUEST_LIMIT} запросов в сутки). Попробуйте завтра.`,
        },
        { status: 429 },
      );
    }
    await bumpQuota(bot.id, 1, 0);

    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
    const query = messageText(lastUserMessage);
    if (!query) {
      return jsonError('Empty query', 400);
    }

    // --- retrieval
    const sources = await hybridSearch(bot.id, query, bot.top_k ?? 6);
    const system = buildSystemPrompt(bot.system_prompt ?? '', sources);

    // --- persistence (best effort for the user message)
    const conversationId = sessionKey ? await ensureConversation(bot.id, sessionKey) : null;
    if (conversationId) {
      try {
        await saveUserMessage(conversationId, query);
      } catch (err) {
        console.warn('[chat] failed to persist user message:', err);
      }
    }

    // --- generation
    const result = streamText({
      model: resolveModel(bot.model_id),
      instructions: system,
      messages: await convertToModelMessages(messages),
      temperature: bot.thinking_enabled ? undefined : bot.temperature,
      providerOptions: {
        deepseek: {
          thinking: { type: bot.thinking_enabled ? 'enabled' : 'disabled' },
        },
      },
    });

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        writer.write({
          type: 'data-sources',
          id: 'sources',
          data: {
            items: sources.map((source, index) => ({
              n: index + 1,
              title: source.title,
              source: source.source,
              similarity: source.similarity,
            })),
          },
        });

        await writer.merge(toUIMessageStream({ stream: result.stream }));

        // After the stream completes: persist the answer and hand the
        // client the stored message id so it can send feedback.
        const text = await result.text;
        const usage = (await result.usage) as
          | { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number }
          | undefined;
        const inputTokens = usage?.inputTokens ?? usage?.promptTokens ?? 0;
        const outputTokens = usage?.outputTokens ?? usage?.completionTokens ?? 0;

        if (conversationId) {
          try {
            const messageId = await saveAssistantMessage(conversationId, {
              content: text,
              citations: sources.map((source, index) => ({
                n: index + 1,
                chunkId: source.chunkId,
                documentId: source.documentId,
                title: source.title,
                source: source.source,
                similarity: source.similarity,
              })),
              model: bot.model_id,
              inputTokens,
              outputTokens,
              costUsd: estimateCostUsd(bot.model_id, inputTokens, outputTokens),
              latencyMs: Date.now() - startedAt,
            });
            writer.write({
              type: 'data-feedback',
              id: 'feedback',
              data: { messageId, conversationId },
            });
          } catch (err) {
            console.warn('[chat] failed to persist assistant message:', err);
          }
        }

        if (inputTokens + outputTokens > 0) {
          await bumpQuota(bot.id, 0, inputTokens + outputTokens);
        }
      },
    });

    return createUIMessageStreamResponse({ stream });
  } catch (err) {
    console.error('[chat] unhandled error:', err);
    return jsonError('Internal error', 500);
  }
}
