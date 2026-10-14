/**
 * Admin purchases API (sql/0004_card.sql).
 *
 * GET  /api/admin/purchases?visitorId=...   — the visitor's purchases
 * POST /api/admin/purchases                  — add a purchase
 *
 * { available: false } when the 0004 migration is not applied yet.
 */

import { adminGuard } from '@/lib/admin-auth';
import { getVisitorById } from '@/lib/visitors';
import {
  addPurchase,
  listPurchases,
  purchasesAvailable,
  PURCHASE_STATUSES,
  type PurchaseStatus,
} from '@/lib/purchases';

export async function GET(req: Request): Promise<Response> {
  const guard = adminGuard(req);
  if (guard) return guard;

  const visitorId = new URL(req.url).searchParams.get('visitorId')?.trim() ?? '';
  if (!visitorId) {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }

  try {
    const available = await purchasesAvailable();
    if (!available) return Response.json({ available: false, purchases: [] });
    const purchases = await listPurchases(visitorId, 50);
    return Response.json({ available: true, purchases });
  } catch (err) {
    console.error('[admin] purchases load failed:', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}

type PurchaseBody = {
  visitorId?: string;
  title?: string;
  amount?: unknown;
  currency?: string;
  status?: string;
  orderedAt?: string;
};

export async function POST(req: Request): Promise<Response> {
  const guard = adminGuard(req);
  if (guard) return guard;

  const body = (await req.json().catch(() => null)) as PurchaseBody | null;
  const visitorId = body?.visitorId?.trim() ?? '';
  const title = body?.title?.trim().slice(0, 160) ?? '';
  if (!visitorId || !title) {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }

  const status: PurchaseStatus =
    typeof body?.status === 'string' && (PURCHASE_STATUSES as readonly string[]).includes(body.status)
      ? (body.status as PurchaseStatus)
      : 'completed';

  const amountRaw = body?.amount;
  const amount =
    typeof amountRaw === 'number' && Number.isFinite(amountRaw)
      ? Math.max(0, Math.round(amountRaw * 100) / 100)
      : null;

  const currency = typeof body?.currency === 'string' && body.currency.trim() ? body.currency.trim().slice(0, 8) : 'RUB';

  try {
    const visitor = await getVisitorById(visitorId);
    if (!visitor) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    const purchase = await addPurchase({
      botId: visitor.bot_id,
      visitorId,
      title,
      amount,
      currency,
      status,
      orderedAt: body?.orderedAt ?? null,
    });
    if (!purchase) {
      return Response.json({ available: false }, { status: 422 });
    }
    return Response.json({ purchase });
  } catch (err) {
    console.error('[admin] purchase add failed:', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
