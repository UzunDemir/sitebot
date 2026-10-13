/**
 * Admin visitors API: the visitor list for one bot (карточка посетителя).
 *
 * GET /api/admin/visitors?botId=...
 *
 * Returns cards ordered by last_seen plus per-visitor conversation counts.
 * When sql/0003_seller.sql is not applied yet, answers { visitors: [],
 * available: false } so the admin UI can show a migration hint.
 */

import { connection } from 'next/server';
import { adminGuard } from '@/lib/admin-auth';
import { getSupabase } from '@/lib/supabase';
import { isMissingRelationError, parseVisitorRow } from '@/lib/visitors';

export async function GET(req: Request): Promise<Response> {
  await connection();

  const guard = adminGuard(req);
  if (guard) return guard;

  const botId = new URL(req.url).searchParams.get('botId')?.trim() ?? '';
  if (!botId) {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('visitors')
      .select(
        'id, bot_id, visitor_key, name, contacts, tags, notes, memory_digest, do_not_disturb, meta, first_seen, last_seen',
      )
      .eq('bot_id', botId)
      .order('last_seen', { ascending: false })
      .limit(200);

    if (error) {
      if (isMissingRelationError(error)) {
        return Response.json({ visitors: [], available: false });
      }
      throw error;
    }

    const visitors = (data ?? []).map((row) => parseVisitorRow(row as Record<string, unknown>));

    // Conversation counts (one extra query for the visible page of cards).
    const counts = new Map<string, number>();
    const ids = visitors.map((v) => v.id);
    if (ids.length > 0) {
      const conv = await supabase.from('conversations').select('visitor_id').in('visitor_id', ids);
      if (!conv.error) {
        for (const row of conv.data ?? []) {
          const visitorId = row.visitor_id as string | null;
          if (!visitorId) continue;
          counts.set(visitorId, (counts.get(visitorId) ?? 0) + 1);
        }
      }
    }

    return Response.json({
      available: true,
      visitors: visitors.map((visitor) => ({
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
        conversationsCount: counts.get(visitor.id) ?? 0,
      })),
    });
  } catch (err) {
    console.error('[admin] visitors load failed:', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
