/**
 * Chat endpoint.
 *
 * Pipeline: validate bot -> embed query -> hybrid search (vector + FTS, RRF)
 * -> build grounded prompt -> streamText (DeepSeek) -> stream UI messages
 * with a `data-sources` part, persisting usage/cost on finish.
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
      onFinish: async ({ text, usage }) => {
        if (!conversationId) return;
        const u = usage as
          | { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number }
          | undefined;
        const inputTokens = u?.inputTokens ?? u?.promptTokens ?? 0;
        const outputTokens = u?.outputTokens ?? u?.completionTokens ?? 0;
        const latencyMs = Date.now() - startedAt;
        try {
          await saveAssistantMessage(conversationId, {
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
            latencyMs,
          });
        } catch (err) {
          console.warn('[chat] failed to persist assistant message:', err);
        }
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
        writer.merge(toUIMessageStream({ stream: result.stream }));
      },
    });

    return createUIMessageStreamResponse({ stream });
  } catch (err) {
    console.error('[chat] unhandled error:', err);
    return jsonError('Internal error', 500);
  }
}
