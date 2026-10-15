/**
 * Admin visitor card: detail (conversations, purchases, event feed) and
 * editing (name, birthday, contacts, tags, notes, preferences, complaints,
 * do-not-disturb).
 *
 * GET   /api/admin/visitors/[id]
 * PATCH /api/admin/visitors/[id]
 *
 * Falls back gracefully on the pre-0004 schema (extended fields skipped).
 */

import { adminGuard } from '@/lib/admin-auth';
import { getSupabase } from '@/lib/supabase';
import { isMissingColumnError } from '@/lib/bot-settings';
import {
  CONTACT_KEYS,
  isMissingRelationError,
  parseVisitorRow,
  VISITOR_COLUMNS,
  VISITOR_COLUMNS_V4,
  type VisitorRow,
} from '@/lib/visitors';
import { formatBirthday, makeBirthday, parseBirthday, serializeBirthday } from '@/lib/birthday';
import { listPurchases, purchasesAvailable } from '@/lib/purchases';
import { listMemoryResets } from '@/lib/memory-window';

function clientShape(visitor: VisitorRow) {
  const birthday = makeBirthday(visitor.birthday_day, visitor.birthday_month, visitor.birthday_year);
  return {
    id: visitor.id,
    visitorKey: visitor.visitor_key,
    name: visitor.name,
    contacts: visitor.contacts,
    tags: visitor.tags,
    notes: visitor.notes,
    memoryDigest: visitor.memory_digest,
    doNotDisturb: visitor.do_not_disturb,
    birthday: birthday ? serializeBirthday(birthday) : null,
    birthdayText: birthday ? formatBirthday(birthday) : null,
    preferences: visitor.preferences,
    complaints: visitor.complaints,
    firstSeen: visitor.first_seen,
    lastSeen: visitor.last_seen,
  };
}

/** Read the card with 0004 columns; false when the row came without them. */
async function loadCard(
  supabase: ReturnType<typeof getSupabase>,
  id: string,
): Promise<{ visitor: VisitorRow | null; available: boolean }> {
  let res = await supabase.from('visitors').select(VISITOR_COLUMNS_V4).eq('id', id).maybeSingle();
  let schemaV4 = true;
  if (res.error && isMissingColumnError(res.error)) {
    res = await supabase.from('visitors').select(VISITOR_COLUMNS).eq('id', id).maybeSingle();
    schemaV4 = false;
  }
  if (res.error) {
    if (isMissingRelationError(res.error)) return { visitor: null, available: false };
    throw res.error;
  }
  return { visitor: res.data ? parseVisitorRow(res.data as unknown as Record<string, unknown>, schemaV4) : null, available: true };
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
    const { visitor, available } = await loadCard(supabase, id);
    if (!available) return Response.json({ available: false });
    if (!visitor) return Response.json({ error: 'not_found' }, { status: 404 });

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

    // Purchases (sql/0004).
    const purchases = await listPurchases(visitor.id, 20);
    const purchasesReady = purchases.length > 0 || (await purchasesAvailable());

    // Memory epochs (sql/0005): «забыть меня» — лента сбросов и возврат.
    const memoryResets = await listMemoryResets(visitor.id);

    return Response.json({
      available: true,
      visitor: clientShape(visitor),
      purchasesAvailable: purchasesReady,
      purchases: purchases.map((purchase) => ({
        id: purchase.id,
        title: purchase.title,
        amount: purchase.amount,
        currency: purchase.currency,
        status: purchase.status,
        orderedAt: purchase.orderedAt,
      })),
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
      memoryResets: memoryResets.map((reset) => ({
        id: reset.id,
        source: reset.source,
        createdAt: reset.createdAt,
        revokedAt: reset.revokedAt,
        snapshot: reset.snapshot,
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
  const extPatch: Record<string, unknown> = {};

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

  // --- sql/0004 extensions
  if (typeof body.birthday === 'string') {
    const raw = body.birthday.trim();
    if (!raw) {
      extPatch.birthday_day = null;
      extPatch.birthday_month = null;
      extPatch.birthday_year = null;
    } else {
      const parsed = parseBirthday(raw);
      if (!parsed) {
        return Response.json({ error: 'bad_birthday' }, { status: 400 });
      }
      extPatch.birthday_day = parsed.day;
      extPatch.birthday_month = parsed.month;
      extPatch.birthday_year = parsed.year;
    }
  }
  for (const key of ['preferences', 'complaints'] as const) {
    if (Array.isArray(body[key])) {
      extPatch[key] = (body[key] as unknown[])
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().replace(/\s+/g, ' ').slice(0, key === 'preferences' ? 60 : 160))
        .filter(Boolean)
        .slice(0, 8);
    }
  }

  if (Object.keys(patch).length === 0 && Object.keys(extPatch).length === 0) {
    return Response.json({ error: 'nothing_to_update' }, { status: 400 });
  }

  try {
    const supabase = getSupabase();

    // Try the full update; on a missing 0004 column retry without extensions.
    let updated: VisitorRow | null = null;
    let res = await supabase
      .from('visitors')
      .update({ ...patch, ...extPatch })
      .eq('id', id)
      .select(VISITOR_COLUMNS_V4)
      .single();
    if (res.error && isMissingColumnError(res.error)) {
      if (Object.keys(patch).length === 0) {
        // The update carried only 0004 fields — without the migration there
        // is nothing to write (the panel shows the migration hint).
        return Response.json({ available: false, error: 'schema_v4_required' }, { status: 422 });
      }
      res = await supabase.from('visitors').update(patch).eq('id', id).select(VISITOR_COLUMNS).single();
    }
    if (res.error) {
      if (isMissingRelationError(res.error)) {
        return Response.json({ available: false }, { status: 422 });
      }
      throw res.error;
    }
    updated = parseVisitorRow(res.data as unknown as Record<string, unknown>, true);

    return Response.json({ visitor: clientShape(updated) });
  } catch (err) {
    console.error('[admin] visitor update failed:', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
