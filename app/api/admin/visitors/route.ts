/**
 * Admin visitors API: the visitor list for one bot (карточка посетителя).
 *
 * GET /api/admin/visitors?botId=...
 *
 * Returns cards ordered by last_seen plus per-visitor conversation counts.
 * Columns of sql/0004 (birthday, preferences, complaints) are read when
 * present; a pre-0004 schema falls back gracefully. When sql/0003 is not
 * applied yet, answers { visitors: [], available: false }.
 */

import { connection } from 'next/server';
import { adminGuard } from '@/lib/admin-auth';
import { getSupabase } from '@/lib/supabase';
import { isMissingColumnError } from '@/lib/bot-settings';
import { isMissingRelationError, parseVisitorRow, VISITOR_COLUMNS, VISITOR_COLUMNS_V4 } from '@/lib/visitors';
import { makeBirthday, serializeBirthday } from '@/lib/birthday';

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

    // 0004 columns first; a missing column falls back to the 0003 shape.
    const rows: Record<string, unknown>[] = [];
    let loadError: unknown = null;
    let schemaV4 = true;

    const first = await supabase
      .from('visitors')
      .select(VISITOR_COLUMNS_V4)
      .eq('bot_id', botId)
      .order('last_seen', { ascending: false })
      .limit(200);
    if (first.error && isMissingColumnError(first.error)) {
      const fallback = await supabase
        .from('visitors')
        .select(VISITOR_COLUMNS)
        .eq('bot_id', botId)
        .order('last_seen', { ascending: false })
        .limit(200);
      schemaV4 = false;
      loadError = fallback.error ?? null;
      for (const row of (fallback.data ?? []) as unknown as Record<string, unknown>[]) rows.push(row);
    } else {
      loadError = first.error ?? null;
      for (const row of (first.data ?? []) as unknown as Record<string, unknown>[]) rows.push(row);
    }

    if (loadError) {
      if (isMissingRelationError(loadError)) {
        return Response.json({ visitors: [], available: false });
      }
      throw loadError;
    }

    const visitors = rows.map((row) => parseVisitorRow(row, schemaV4));

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
      visitors: visitors.map((visitor) => {
        const birthday = makeBirthday(
          visitor.birthday_day,
          visitor.birthday_month,
          visitor.birthday_year,
        );
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
          preferences: visitor.preferences,
          complaints: visitor.complaints,
          firstSeen: visitor.first_seen,
          lastSeen: visitor.last_seen,
          conversationsCount: counts.get(visitor.id) ?? 0,
        };
      }),
    });
  } catch (err) {
    console.error('[admin] visitors load failed:', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
