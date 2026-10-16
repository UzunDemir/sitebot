/**
 * Widget events endpoint (sql/0003_seller.sql).
 *
 * POST { botKey, sessionKey?, visitorKey?, type, payload? }
 *
 * Stores lightweight funnel events (session_start, page_hidden, ...).
 * Best effort: an unknown bot is 404, but a missing events table (0003 not
 * applied) answers 200 with stored:false so the widget never breaks.
 */

import { getSupabase } from '@/lib/supabase';
import { ensureVisitor, isMissingRelationError } from '@/lib/visitors';
import { getConversationId } from '@/lib/chat-store';

/** Types produced by the widget and the server (nudges arrive in Ф3). */
const EVENT_TYPES = new Set([
  'session_start',
  'page_hidden',
  'stop_request',
  'goal_reached',
  'session_closed',
  'nudge_sent',
  'nudge_answered',
  'memory_reset',
  'refusal',
  'style_flags',
]);

const MAX_PAYLOAD = 2000;

type EventsBody = {
  botKey?: string;
  sessionKey?: string;
  visitorKey?: string;
  type?: string;
  payload?: unknown;
};

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => null)) as EventsBody | null;
    const botKey = body?.botKey?.trim() ?? '';
    const type = body?.type?.trim() ?? '';
    if (!botKey || !type) {
      return Response.json({ error: 'bad_request' }, { status: 400 });
    }
    if (!EVENT_TYPES.has(type)) {
      return Response.json({ error: 'unknown_event_type' }, { status: 400 });
    }

    const supabase = getSupabase();
    const botRes = await supabase
      .from('bots')
      .select('id')
      .eq('public_key', botKey)
      .eq('is_active', true)
      .maybeSingle();
    if (botRes.error) throw botRes.error;
    const botId = (botRes.data?.id as string | undefined) ?? null;
    if (!botId) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }

    const sessionKey = body?.sessionKey?.trim() ?? '';
    const visitorKey = body?.visitorKey?.trim() ?? '';

    const visitorId = visitorKey ? await ensureVisitor(botId, visitorKey) : null;
    const conversationId = sessionKey ? await getConversationId(botId, sessionKey) : null;

    let payload: Record<string, unknown> = {};
    if (body?.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)) {
      const candidate = body.payload as Record<string, unknown>;
      if (JSON.stringify(candidate).length <= MAX_PAYLOAD) payload = candidate;
    }

    const { error } = await supabase.from('events').insert({
      bot_id: botId,
      visitor_id: visitorId,
      conversation_id: conversationId,
      type,
      payload,
    });
    if (error) {
      if (isMissingRelationError(error)) {
        return Response.json({ ok: true, stored: false });
      }
      console.warn('[events] insert failed:', error.message);
      return Response.json({ ok: true, stored: false });
    }

    return Response.json({ ok: true, stored: true });
  } catch (err) {
    console.error('[events] unhandled error:', err);
    return Response.json({ ok: false }, { status: 500 });
  }
}
