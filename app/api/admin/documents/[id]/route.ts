/**
 * Admin documents API:
 *   POST   — (re)index a stored document (used to retry failed ones;
 *            the text is kept on the row, so no re-upload is needed).
 *   DELETE — remove a document (chunks are removed by FK cascade).
 */

import { adminGuard } from '@/lib/admin-auth';
import { getSupabase } from '@/lib/supabase';
import { ingestDocument } from '@/lib/ingest';

export const maxDuration = 60;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = adminGuard(req);
  if (guard) return guard;

  const { id } = await ctx.params;
  const supabase = getSupabase();

  const doc = await supabase
    .from('documents')
    .select('id, bot_id, title, source, content')
    .eq('id', id)
    .maybeSingle();
  if (doc.error) {
    console.error('[admin] document lookup failed:', doc.error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
  if (!doc.data) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  try {
    const outcome = await ingestDocument({
      botId: doc.data.bot_id as string,
      title: doc.data.title as string,
      source: doc.data.source as string | null,
      content: doc.data.content as string,
    });
    return Response.json({ ok: true, ...outcome });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[admin] reindex failed:', message);
    return Response.json({ error: 'ingest_failed', message }, { status: 422 });
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = adminGuard(req);
  if (guard) return guard;

  const { id } = await ctx.params;
  const supabase = getSupabase();
  const del = await supabase.from('documents').delete().eq('id', id);
  if (del.error) {
    console.error('[admin] document delete failed:', del.error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }

  return Response.json({ ok: true });
}
