/**
 * Admin documents API: delete a document (chunks are removed by FK cascade).
 */

import { adminGuard } from '@/lib/admin-auth';
import { getSupabase } from '@/lib/supabase';

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
