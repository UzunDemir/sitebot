/**
 * Admin: эпохи памяти посетителя (Ф6, sql/0005_memory_reset.sql).
 *
 * POST { resetId, revoked }
 *   revoked=true  — «вернуть память в активную»: маркер эпохи перестаёт резать
 *                   активное окно (старая переписка снова видна модели), а
 *                   снимок эпохи возвращается в ПУСТЫЕ поля карточки.
 *   revoked=false — «скрыть обратно»: маркер снова скрывает эпоху; карточка
 *                   НЕ чистится повторно (правки владельца не теряются).
 *
 * Память никогда не удаляется: обе операции меняют только видимость эпохи.
 */

import { adminGuard } from '@/lib/admin-auth';
import { getSupabase } from '@/lib/supabase';
import { recordEvent } from '@/lib/visitors';
import {
  getMemoryResetById,
  listMemoryResets,
  restoreMemorySnapshot,
  setMemoryResetRevoked,
} from '@/lib/memory-window';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = adminGuard(req);
  if (guard) return guard;

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { resetId?: unknown; revoked?: unknown } | null;
  const resetId = typeof body?.resetId === 'string' ? body.resetId.trim() : '';
  if (!resetId || typeof body?.revoked !== 'boolean') {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  const revoked = body.revoked === true;

  try {
    const supabase = getSupabase();
    const card = await supabase.from('visitors').select('id').eq('id', id).maybeSingle();
    if (card.error) throw card.error;
    if (!card.data) return Response.json({ error: 'not_found' }, { status: 404 });

    const reset = await getMemoryResetById(resetId);
    if (!reset || reset.visitorId !== id) {
      return Response.json({ error: 'reset_not_found' }, { status: 404 });
    }

    const updated = await setMemoryResetRevoked(resetId, revoked);
    if (!updated) return Response.json({ error: 'update_failed' }, { status: 500 });

    if (revoked) {
      await restoreMemorySnapshot(id, reset.snapshot);
    }
    await recordEvent({
      botId: reset.botId,
      visitorId: id,
      type: revoked ? 'memory_restored' : 'memory_hidden',
      payload: { resetId },
    });

    return Response.json({ ok: true, memoryResets: await listMemoryResets(id) });
  } catch (err) {
    console.error('[admin] memory epoch failed:', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
