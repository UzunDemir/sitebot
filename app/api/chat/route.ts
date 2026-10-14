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
  type ModelMessage,
  type UIMessage,
} from 'ai';
import { after } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '@/lib/supabase';
import { resolveModel } from '@/lib/models';
import { hybridSearch } from '@/lib/retrieval';
import { buildSystemPrompt } from '@/lib/prompts';
import {
  ensureConversation,
  loadConversationById,
  loadRecentMessages,
  saveUserMessage,
  saveAssistantMessage,
  updateConversationFields,
} from '@/lib/chat-store';
import {
  attachConversationToVisitor,
  ensureVisitorRow,
  recordEvent,
  updateVisitorProfile,
  type VisitorRow,
} from '@/lib/visitors';
import { runStrategist } from '@/lib/visitor-memory';
import { isStopRequest, STOP_REPLY } from '@/lib/nudge';
import { describeNow } from '@/lib/clock';
import { formatBirthday, isBirthdayToday, makeBirthday, type Birthday } from '@/lib/birthday';
import { listPurchases, summarizePurchases } from '@/lib/purchases';
import { estimateCostUsd } from '@/lib/pricing';
import { BOT_SETTINGS_DEFAULTS, isMissingColumnError, parseBotSettings } from '@/lib/bot-settings';

export const maxDuration = 60;

/** Demo-grade per-bot daily quota (chat requests). */
const DAILY_REQUEST_LIMIT = 300;

/** Sanity cap for «вся история» (historyDepth = 0). */
const MODEL_CONTEXT_MAX = 200;

type ChatRequestBody = {
  messages?: UIMessage[];
  botKey?: string;
  sessionKey?: string;
  visitorKey?: string;
  /** IANA-таймзона посетителя (Intl) — для «осознания времени». */
  tz?: string;
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
    const tz = body.tz?.trim() ?? '';
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

    // --- memory window: how many recent dialog messages the model sees
    // (0 = the whole dialog; the actual context is read from the DB below).
    const depth = settings.historyDepth ?? BOT_SETTINGS_DEFAULTS.historyDepth;

    // --- persistence + visitor card (sql/0003), before prompts: the memory
    // block and the stop-word handling both need the card. Best effort —
    // the chat works without the migration.
    const conversationId = sessionKey ? await ensureConversation(bot.id, sessionKey) : null;
    if (conversationId) {
      try {
        await saveUserMessage(conversationId, query);
      } catch (err) {
        console.warn('[chat] failed to persist user message:', err);
      }
    }

    let visitorId: string | null = null;
    let visitorRow: VisitorRow | null = null;
    if (visitorKey && conversationId) {
      visitorRow = await ensureVisitorRow(bot.id, visitorKey);
      visitorId = visitorRow?.id ?? null;
      if (visitorId) await attachConversationToVisitor(conversationId, visitorId);
    }
    const conversationMeta = conversationId ? await loadConversationById(conversationId) : null;

    // --- «ответ отменяет дожим»: счётчик сбрасывается + событие для метрик.
    if (conversationId && conversationMeta && conversationMeta.nudgesSent > 0) {
      await recordEvent({
        botId: bot.id,
        visitorId,
        conversationId,
        type: 'nudge_answered',
        payload: { nudges: conversationMeta.nudgesSent },
      });
      await updateConversationFields(conversationId, { nudges_sent: 0 });
    }

    // --- потерянный диалог оживает: посетитель снова пишет — стратегия и
    // дожим продолжаются (глухие стопы — цель достигнута / стоп-слово).
    if (conversationId && conversationMeta && conversationMeta.outcome === 'lost') {
      await updateConversationFields(conversationId, { outcome: 'in_progress' });
      await recordEvent({ botId: bot.id, visitorId, conversationId, type: 'dialog_resumed' });
    }

    // --- стоп-слова: DND навсегда, вежливый ответ без LLM и без поиска.
    if (isStopRequest(query)) {
      if (visitorId) await updateVisitorProfile(visitorId, { do_not_disturb: true });
      if (conversationId) await updateConversationFields(conversationId, { outcome: 'stopped' });
      await recordEvent({ botId: bot.id, visitorId, conversationId, type: 'stop_request' });

      const stopStream = createUIMessageStream({
        execute: async ({ writer }) => {
          writer.write({ type: 'start' });
          writer.write({ type: 'start-step' });
          writer.write({ type: 'text-start', id: 'stop-reply' });
          writer.write({ type: 'text-delta', id: 'stop-reply', delta: STOP_REPLY });
          writer.write({ type: 'text-end', id: 'stop-reply' });
          if (conversationId) {
            try {
              const messageId = await saveAssistantMessage(conversationId, {
                content: STOP_REPLY,
                citations: [],
                model: bot.model_id,
                inputTokens: 0,
                outputTokens: 0,
                costUsd: 0,
                latencyMs: Date.now() - startedAt,
              });
              writer.write({
                type: 'data-feedback',
                id: 'feedback',
                data: { messageId, conversationId },
              });
            } catch (err) {
              console.warn('[chat] failed to persist stop reply:', err);
            }
          }
          writer.write({ type: 'finish-step' });
          writer.write({ type: 'finish' });
        },
      });
      return createUIMessageStreamResponse({ stream: stopStream });
    }

    // --- retrieval + grounded prompt (memory block + time awareness)
    const sources = await hybridSearch(bot.id, query, bot.top_k ?? 6);

    // Текущее время в таймзоне посетителя; день рождения и покупки (0004).
    const now = new Date();
    const nowInfo = describeNow(tz, now);
    let birthday: Birthday | null = null;
    let birthdayToday = false;
    let purchasesSummary: string | null = null;
    if (visitorRow) {
      birthday = makeBirthday(visitorRow.birthday_day, visitorRow.birthday_month, visitorRow.birthday_year);
      if (birthday) birthdayToday = isBirthdayToday(birthday, nowInfo.timeZone, now);
      if (visitorRow.schema_v4) {
        purchasesSummary = summarizePurchases(await listPurchases(visitorRow.id, 20));
      }
    }

    const memory = visitorRow
      ? {
          name: visitorRow.name,
          contacts: visitorRow.contacts,
          interests: Array.isArray(visitorRow.meta.interests)
            ? (visitorRow.meta.interests as unknown[]).filter(
                (item): item is string => typeof item === 'string',
              )
            : [],
          digest: visitorRow.memory_digest,
          stage: conversationMeta?.stage ?? 'greeting',
          returning: Boolean(visitorRow.name || visitorRow.memory_digest),
          birthday: birthday ? formatBirthday(birthday) : null,
          birthdayToday,
          preferences: visitorRow.preferences,
          complaints: visitorRow.complaints,
          purchases: purchasesSummary,
        }
      : undefined;
    const system = buildSystemPrompt(bot.system_prompt ?? '', sources, settings, memory, nowInfo.text);
    const showSources = settings.showSources !== false;

    // --- model context: dialog memory lives in the DB, not in the UI. The
    // widget always shows a fresh feed (see the spec: «историю не выводим»),
    // so the server assembles the context from the stored conversation —
    // the last `historyDepth` messages, including the one just saved.
    let modelMessages: ModelMessage[];
    if (conversationId) {
      const limit = depth === 0 ? MODEL_CONTEXT_MAX : depth;
      const { messages: stored } = await loadRecentMessages(conversationId, limit);
      modelMessages = stored.map((message) => ({
        role: message.role,
        content: message.content,
      }));
      const tail = stored[stored.length - 1];
      if (!tail || tail.role !== 'user' || tail.content !== query) {
        // Persistence failed, or the tail is a proactive nudge — the current
        // question must still reach the model.
        modelMessages.push({ role: 'user', content: query });
      }
    } else {
      // No session key: fall back to the dialog the client sent.
      const legacyHistory =
        depth > 0 && messages.length > depth ? messages.slice(-depth) : messages;
      modelMessages = await convertToModelMessages(legacyHistory);
    }

    // --- generation
    const result = streamText({
      model: resolveModel(bot.model_id),
      instructions: system,
      messages: modelMessages,
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

    // Dialog strategist (best effort, after the response is sent): facts,
    // dialog stage and goal state for the visitor card.
    const strategistVisitorId = visitorId;
    if (strategistVisitorId && conversationId) {
      const strategistContext = {
        goal: settings.goal ?? ('none' as const),
        goalText: settings.goalText ?? '',
        nowText: nowInfo.text,
      };
      after(async () => {
        try {
          await runStrategist(strategistVisitorId, conversationId, strategistContext);
        } catch (err) {
          console.warn('[chat] strategist failed:', err);
        }
      });
    }

    return createUIMessageStreamResponse({ stream });
  } catch (err) {
    console.error('[chat] unhandled error:', err);
    return jsonError('Internal error', 500);
  }
}
