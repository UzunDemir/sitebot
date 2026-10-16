/**
 * Admin: быстрые реплики бота (каскад ответа, sql/0008).
 *
 * GET  — список реплик + категории (подписи для формы).
 * POST — действия: add | toggle | delete | reseed (все возвращают список).
 */

import { adminGuard } from '@/lib/admin-auth';
import {
  addFiller,
  deleteFiller,
  loadBotFillers,
  seedBotFillers,
  setFillerEnabled,
} from '@/lib/filler-store';
import { FILLER_CATEGORIES, sanitizeFillerText } from '@/lib/fillers';

type Body = {
  action?: unknown;
  fillerId?: unknown;
  enabled?: unknown;
  kind?: unknown;
  tone?: unknown;
  category?: unknown;
  text?: unknown;
};

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const guard = adminGuard(req);
  if (guard) return guard;
  const { id } = await ctx.params;
  return Response.json({
    fillers: await loadBotFillers(id),
    categories: [
      ...FILLER_CATEGORIES.map((category) => ({ id: category.id, label: category.label })),
      { id: 'generic', label: 'Общие' },
    ],
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const guard = adminGuard(req);
  if (guard) return guard;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as Body | null;
  const action = typeof body?.action === 'string' ? body.action : '';

  if (action === 'add') {
    const kind = body?.kind === 'slow' ? 'slow' : 'ack';
    const tone = body?.tone === 'empathetic' ? 'empathetic' : 'neutral';
    const category = typeof body?.category === 'string' && body.category ? body.category : 'generic';
    const text = typeof body?.text === 'string' ? sanitizeFillerText(body.text) : '';
    if (!text) return Response.json({ error: 'bad_request' }, { status: 400 });
    const ok = await addFiller(id, { kind, tone, category, text });
    if (!ok) return Response.json({ error: 'save_failed' }, { status: 500 });
    return Response.json({ ok: true, fillers: await loadBotFillers(id) });
  }

  if (action === 'toggle') {
    const fillerId = typeof body?.fillerId === 'string' ? body.fillerId : '';
    if (!fillerId || typeof body?.enabled !== 'boolean') {
      return Response.json({ error: 'bad_request' }, { status: 400 });
    }
    const ok = await setFillerEnabled(id, fillerId, body.enabled);
    if (!ok) return Response.json({ error: 'save_failed' }, { status: 500 });
    return Response.json({ ok: true, fillers: await loadBotFillers(id) });
  }

  if (action === 'delete') {
    const fillerId = typeof body?.fillerId === 'string' ? body.fillerId : '';
    if (!fillerId) return Response.json({ error: 'bad_request' }, { status: 400 });
    const ok = await deleteFiller(id, fillerId);
    if (!ok) return Response.json({ error: 'save_failed' }, { status: 500 });
    return Response.json({ ok: true, fillers: await loadBotFillers(id) });
  }

  if (action === 'reseed') {
    await seedBotFillers(id);
    return Response.json({ ok: true, fillers: await loadBotFillers(id) });
  }

  return Response.json({ error: 'unknown_action' }, { status: 400 });
}
