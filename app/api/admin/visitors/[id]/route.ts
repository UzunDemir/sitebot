/**
 * Admin visitor card: detail (conversations + event feed) and editing
 * (name, contacts, tags, notes, do-not-disturb).
 *
 * GET   /api/admin/visitors/[id]
 * PATCH /api/admin/visitors/[id]
 */

import { adminGuard } from '@/lib/admin-auth';
import { getSupabase } from '@/lib/supabase';
import { isMissingColumnError } from '@/lib/bot-settings';
import { CONTACT_KEYS, isMissingRelationError, parseVisitorRow } from '@/lib/visitors';

const VISITOR_COLUMNS =
  'id, bot_id, visitor_key, name, contacts, tags, notes, memory_digest, do_not_disturb, meta, first_seen, last_seen';

function clientShape(visitor: ReturnType<typeof parseVisitorRow>) {
  return {
    id: visitor.id,
    visitorKey: visitor.visitor_key,
    name: visitor.name,
    contacts: visitor.contacts,
    tags: visitor.tags,
    notes: visitor.notes,
    memoryDigest: visitor.memory_digest,
    doNotDisturb: visitor.do_not_disturb,
    firstSeen: visitor.first_seen,
    lastSeen: visitor.last_seen,
  };
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = adminGuard(req);
  if (guard) return guard;

  const { id } = await ctx.params;

  try {
    const supabase = getSupabase();
    const row = await supabase.from('visitors').select(VISITOR_COLUMNS).eq('id', id).maybeSingle();
    if (row.error) {
      if (isMissingRelationError(row.error)) {
        return Response.json({ available: false });
      }
      throw row.error;
    }
    if (!row.data) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    const visitor = parseVisitorRow(row.data as Record<string, unknown>);

    // Conversations of this visitor (stage/outcome arrive with sql/0003).
    let conversations: Array<Record<string, unknown>> = [];
    const convRes = await supabase
      .from('conversations')
      .select('id, created_at, last_active_at, stage, outcome, nudges_sent')
      .eq('visitor_id', visitor.id)
      .order('last_active_at', { ascending: false })
      .limit(20);
    if (convRes.error && isMissingColumnError(convRes.error)) {
      const fallback = await supabase
        .from('conversations')
        .select('id, created_at, last_active_at')
        .eq('visitor_id', visitor.id)
        .order('last_active_at', { ascending: false })
        .limit(20);
      if (!fallback.error) conversations = (fallback.data ?? []) as Array<Record<string, unknown>>;
    } else if (!convRes.error) {
      conversations = (convRes.data ?? []) as Array<Record<string, unknown>>;
    }

    // Message counts per conversation (demo-scale: one capped query).
    const messageCounts = new Map<string, number>();
    const convIds = conversations.map((c) => String(c.id));
    if (convIds.length > 0) {
      const msgs = await supabase
        .from('messages')
        .select('conversation_id')
        .in('conversation_id', convIds)
        .limit(5000);
      if (!msgs.error) {
        for (const m of msgs.data ?? []) {
          const convId = m.conversation_id as string | null;
          if (!convId) continue;
          messageCounts.set(convId, (messageCounts.get(convId) ?? 0) + 1);
        }
      }
    }

    // Event feed.
    let events: Array<Record<string, unknown>> = [];
    const evRes = await supabase
      .from('events')
      .select('type, payload, created_at')
      .eq('visitor_id', visitor.id)
      .order('created_at', { ascending: false })
      .limit(30);
    if (!evRes.error) events = (evRes.data ?? []) as Array<Record<string, unknown>>;

    return Response.json({
      available: true,
      visitor: clientShape(visitor),
      conversations: conversations.map((c) => ({
        id: String(c.id),
        createdAt: c.created_at ?? null,
        lastActiveAt: c.last_active_at ?? null,
        stage: typeof c.stage === 'string' ? c.stage : 'greeting',
        outcome: typeof c.outcome === 'string' ? c.outcome : 'in_progress',
        nudgesSent: typeof c.nudges_sent === 'number' ? c.nudges_sent : 0,
        messageCount: messageCounts.get(String(c.id)) ?? 0,
      })),
      events: events.map((e) => ({
        type: typeof e.type === 'string' ? e.type : 'unknown',
        createdAt: e.created_at ?? null,
        payload: e.payload ?? {},
      })),
    });
  } catch (err) {
    console.error('[admin] visitor detail failed:', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = adminGuard(req);
  if (guard) return guard;

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (typeof body.name === 'string') {
    const name = body.name.trim().replace(/\s+/g, ' ').slice(0, 80);
    patch.name = name || null;
  }
  if (typeof body.notes === 'string') {
    patch.notes = body.notes.slice(0, 2000);
  }
  if (Array.isArray(body.tags) || typeof body.tags === 'string') {
    const list = Array.isArray(body.tags) ? body.tags : body.tags.split(',');
    patch.tags = list
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim().slice(0, 30))
      .filter(Boolean)
      .slice(0, 12);
  }
  if (body.contacts && typeof body.contacts === 'object' && !Array.isArray(body.contacts)) {
    const contacts: Record<string, string> = {};
    for (const [key, value] of Object.entries(body.contacts as Record<string, unknown>)) {
      if (!(CONTACT_KEYS as readonly string[]).includes(key)) continue;
      if (typeof value !== 'string') continue;
      const v = value.trim().replace(/\s+/g, ' ').slice(0, 120);
      if (v) contacts[key] = v;
    }
    patch.contacts = contacts;
  }
  if (typeof body.do_not_disturb === 'boolean') {
    patch.do_not_disturb = body.do_not_disturb;
  }

  if (Object.keys(patch).length === 0) {
    return Response.json({ error: 'nothing_to_update' }, { status: 400 });
  }

  try {
    const supabase = getSupabase();
    const upd = await supabase.from('visitors').update(patch).eq('id', id).select(VISITOR_COLUMNS).single();
    if (upd.error) {
      if (isMissingRelationError(upd.error)) {
        return Response.json({ available: false }, { status: 422 });
      }
      throw upd.error;
    }
    return Response.json({ visitor: clientShape(parseVisitorRow(upd.data as Record<string, unknown>)) });
  } catch (err) {
    console.error('[admin] visitor update failed:', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
