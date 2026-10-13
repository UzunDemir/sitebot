/**
 * Chat history endpoint (widget hydration / dialog memory).
 *
 * GET /api/chat/history?botKey=pk_...&sessionKey=...&limit=100
 *
 * Returns the stored conversation as UI messages (text + data-sources +
 * data-feedback parts) so the widget restores the dialog after a reload
 * or a return visit. Read-only: nothing is created here; an unknown
 * session answers with an empty list.
 *
 * Source chips respect the bot's showSources setting; assistant answers
 * come back with their stored rating (if any) so a repeat vote is not
 * invited. Runs strictly at request time — GET handlers must not be
 * prerendered.
 */

import { connection } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { isMissingColumnError, parseBotSettings } from '@/lib/bot-settings';
import {
  getConversationId,
  loadRatings,
  loadRecentMessages,
  type StoredMessage,
} from '@/lib/chat-store';

const HISTORY_DEFAULT_LIMIT = 100;
const HISTORY_MAX_LIMIT = 200;

/** Next.js uses NEXT_* digest errors to control prerendering — never swallow them. */
function isNextInternalError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'digest' in err &&
      String((err as { digest?: unknown }).digest ?? '').startsWith('NEXT_'),
  );
}

type SourceItem = {
  n: number;
  title: string | null;
  source: string | null;
  similarity: number | null;
};

/** Stored citations (jsonb) → the chip shape the widget renders. */
function sourceItems(citations: unknown): SourceItem[] {
  if (!Array.isArray(citations)) return [];
  return citations.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const c = item as Record<string, unknown>;
    return [
      {
        n: typeof c.n === 'number' ? c.n : index + 1,
        title: typeof c.title === 'string' ? c.title : null,
        source: typeof c.source === 'string' ? c.source : null,
        similarity: typeof c.similarity === 'number' ? c.similarity : null,
      },
    ];
  });
}

/** DB row → UI message shape (must match what the live stream produces). */
function toUIMessage(
  message: StoredMessage,
  ratings: Map<number, 1 | -1>,
  conversationId: string,
  showSources: boolean,
): { id: string; role: string; parts: Array<Record<string, unknown>> } {
  const parts: Array<Record<string, unknown>> = [{ type: 'text', text: message.content }];

  if (message.role === 'assistant') {
    const items = sourceItems(message.citations);
    if (showSources && items.length > 0) {
      parts.push({ type: 'data-sources', id: 'sources', data: { items } });
    }
    parts.push({
      type: 'data-feedback',
      id: 'feedback',
      data: { messageId: message.id, conversationId, rating: ratings.get(message.id) ?? 0 },
    });
  }

  return { id: String(message.id), role: message.role, parts };
}

export async function GET(req: Request): Promise<Response> {
  await connection();

  try {
    const url = new URL(req.url);
    const botKey = url.searchParams.get('botKey')?.trim() ?? '';
    const sessionKey = url.searchParams.get('sessionKey')?.trim() ?? '';
    const limitRaw = Number(url.searchParams.get('limit') ?? HISTORY_DEFAULT_LIMIT);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(HISTORY_MAX_LIMIT, Math.max(1, Math.round(limitRaw)))
      : HISTORY_DEFAULT_LIMIT;

    if (!botKey || !sessionKey) {
      return Response.json({ error: 'bad_request' }, { status: 400 });
    }

    const supabase = getSupabase();
    // Same bot resolution as /api/chat; settings are optional (0002 migration).
    const build = (columns: string) =>
      supabase
        .from('bots')
        .select(columns)
        .eq('public_key', botKey)
        .eq('is_active', true)
        .maybeSingle();

    let botRes = await build('id, settings');
    if (botRes.error && isMissingColumnError(botRes.error)) {
      botRes = await build('id');
    }
    if (botRes.error) throw botRes.error;
    const bot = botRes.data as { id: string; settings?: unknown } | null;
    if (!bot) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }

    const conversationId = await getConversationId(bot.id, sessionKey);
    if (!conversationId) {
      return Response.json({ conversationId: null, messages: [], hasMore: false });
    }

    const { messages, hasMore } = await loadRecentMessages(conversationId, limit);
    const ratings = await loadRatings(
      messages.filter((message) => message.role === 'assistant').map((message) => message.id),
    );
    const showSources = parseBotSettings(bot.settings).showSources !== false;

    return Response.json({
      conversationId,
      hasMore,
      messages: messages.map((message) =>
        toUIMessage(message, ratings, conversationId, showSources),
      ),
    });
  } catch (err) {
    if (isNextInternalError(err)) throw err;
    console.error('[chat/history] failed:', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
