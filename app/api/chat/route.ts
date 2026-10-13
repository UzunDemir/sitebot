/**
 * Chat endpoint.
 *
 * Pipeline: validate bot -> daily quota -> embed query -> hybrid search
 * (vector + FTS, RRF) -> grounded prompt (behavior settings applied) ->
 * streamText (DeepSeek) -> UI message stream with `data-sources` (opt)
 * and, after persistence, `data-feedback` (stored message id for ratings).
 */

import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from 'ai';
import { after } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '@/lib/supabase';
import { resolveModel } from '@/lib/models';
import { hybridSearch } from '@/lib/retrieval';
import { buildSystemPrompt } from '@/lib/prompts';
import { ensureConversation, saveUserMessage, saveAssistantMessage } from '@/lib/chat-store';
import { attachConversationToVisitor, ensureVisitor } from '@/lib/visitors';
import { refreshVisitorMemory } from '@/lib/visitor-memory';
import { estimateCostUsd } from '@/lib/pricing';
import { BOT_SETTINGS_DEFAULTS, isMissingColumnError, parseBotSettings } from '@/lib/bot-settings';

export const maxDuration = 60;

/** Demo-grade per-bot daily quota (chat requests). */
const DAILY_REQUEST_LIMIT = 300;

type ChatRequestBody = {
  messages?: UIMessage[];
  botKey?: string;
  sessionKey?: string;
  visitorKey?: string;
};

type BotRow = {
  id: string;
  public_key: string;
  model_id: string;
  system_prompt: string;
  temperature: number;
  thinking_enabled: boolean;
  top_k: number;
  settings?: unknown;
};

const BOT_COLUMNS = 'id, public_key, model_id, system_prompt, temperature, thinking_enabled, top_k, settings';
const BOT_COLUMNS_LEGACY = 'id, public_key, model_id, system_prompt, temperature, thinking_enabled, top_k';

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

/** Fetch the bot; gracefully degrades when sql/0002_settings.sql is not applied. */
async function fetchBot(
  supabase: SupabaseClient,
  publicKey: string | null,
): Promise<BotRow | null> {
  const build = (columns: string) => {
    let query = supabase.from('bots').select(columns).eq('is_active', true);
    query = publicKey
      ? query.eq('public_key', publicKey)
      : query.order('created_at', { ascending: true }).limit(1);
    return query.maybeSingle();
  };

  let result = await build(BOT_COLUMNS);
  if (result.error && isMissingColumnError(result.error)) {
    console.warn('[chat] bots.settings column missing — run sql/0002_settings.sql (defaults applied)');
    result = await build(BOT_COLUMNS_LEGACY);
  }
  if (result.error) throw result.error;
  return (result.data as BotRow | null) ?? null;
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
    const visitorKey = body.visitorKey?.trim() ?? '';
    const startedAt = Date.now();

    // --- resolve bot
    const supabase = getSupabase();
    const bot = await fetchBot(supabase, body.botKey ?? null);
    if (!bot) {
      return jsonError('Bot not found', 404);
    }
    const settings = parseBotSettings(bot.settings);

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

    // --- history depth (0 = full history)
    const depth = settings.historyDepth ?? BOT_SETTINGS_DEFAULTS.historyDepth;
    const history = depth > 0 && messages.length > depth ? messages.slice(-depth) : messages;

    // --- retrieval
    const sources = await hybridSearch(bot.id, query, bot.top_k ?? 6);
    const system = buildSystemPrompt(bot.system_prompt ?? '', sources, settings);
    const showSources = settings.showSources !== false;

    // --- persistence (best effort for the user message)
    const conversationId = sessionKey ? await ensureConversation(bot.id, sessionKey) : null;
    if (conversationId) {
      try {
        await saveUserMessage(conversationId, query);
      } catch (err) {
        console.warn('[chat] failed to persist user message:', err);
      }
    }

    // --- visitor card (sql/0003): link the dialog, refresh memory after
    // the response. Best effort — the chat works without the migration.
    let visitorId: string | null = null;
    if (visitorKey && conversationId) {
      visitorId = await ensureVisitor(bot.id, visitorKey);
      if (visitorId) await attachConversationToVisitor(conversationId, visitorId);
    }

    // --- generation
    const result = streamText({
      model: resolveModel(bot.model_id),
      instructions: system,
      messages: await convertToModelMessages(history),
      temperature: bot.thinking_enabled ? undefined : bot.temperature,
      maxOutputTokens: settings.maxOutputTokens ?? BOT_SETTINGS_DEFAULTS.maxOutputTokens,
      providerOptions: {
        deepseek: {
          thinking: { type: bot.thinking_enabled ? 'enabled' : 'disabled' },
        },
      },
    });

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        if (showSources) {
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
        }

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

    // Dialog memory (best effort, after the response is sent): extract
    // facts from the finished exchange and update the visitor card.
    const memoryVisitorId = visitorId;
    if (memoryVisitorId && conversationId) {
      after(async () => {
        try {
          await refreshVisitorMemory(memoryVisitorId, conversationId);
        } catch (err) {
          console.warn('[chat] visitor memory refresh failed:', err);
        }
      });
    }

    return createUIMessageStreamResponse({ stream });
  } catch (err) {
    console.error('[chat] unhandled error:', err);
    return jsonError('Internal error', 500);
  }
}
