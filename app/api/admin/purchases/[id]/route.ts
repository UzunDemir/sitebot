/**
 * Admin purchases API: delete one purchase (sql/0004_card.sql).
 *
 * DELETE /api/admin/purchases/[id]
 */

import { adminGuard } from '@/lib/admin-auth';
import { deletePurchase } from '@/lib/purchases';

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = adminGuard(req);
  if (guard) return guard;

  const { id } = await ctx.params;
  try {
    const deleted = await deletePurchase(id);
    if (!deleted) {
      return Response.json({ error: 'not_deleted' }, { status: 422 });
    }
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[admin] purchase delete failed:', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
