/**
 * Покупки посетителя (sql/0004_card.sql): где собираем сделки.
 *
 * Наполняется вручную из карточки в админке; история уходит в промпт
 * («бот знает, что уже куплено») и позже — в метрики/интеграции с магазином.
 * Всё best-effort: без миграции 0004 функции тихо возвращают пустые значения.
 */

import { getSupabase } from './supabase';
import { isMissingRelationError } from './visitors';

export const PURCHASE_STATUSES = ['pending', 'completed', 'canceled', 'refunded'] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

export type PurchaseRow = {
  id: string;
  title: string;
  amount: number | null;
  currency: string;
  status: PurchaseStatus;
  orderedAt: string;
};

const PURCHASE_COLUMNS = 'id, title, amount, currency, status, ordered_at';

function parsePurchase(row: Record<string, unknown>): PurchaseRow {
  const status = typeof row.status === 'string' && (PURCHASE_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as PurchaseStatus)
    : 'completed';
  const amountRaw = row.amount;
  const amount = typeof amountRaw === 'number' ? amountRaw : amountRaw === null ? null : Number(amountRaw);
  return {
    id: String(row.id),
    title: typeof row.title === 'string' ? row.title : '',
    amount: Number.isFinite(amount as number) ? (amount as number) : null,
    currency: typeof row.currency === 'string' && row.currency ? row.currency : 'RUB',
    status,
    orderedAt: typeof row.ordered_at === 'string' ? row.ordered_at : new Date().toISOString(),
  };
}

export async function listPurchases(
  visitorId: string,
  limit = 20,
  /** Активное окно памяти (sql/0005): только покупки после этой границы. */
  since?: Date | null,
): Promise<PurchaseRow[]> {
  try {
    const supabase = getSupabase();
    const query = supabase
      .from('purchases')
      .select(PURCHASE_COLUMNS)
      .eq('visitor_id', visitorId)
      .order('ordered_at', { ascending: false })
      .limit(limit);
    const res = since ? await query.gt('ordered_at', since.toISOString()) : await query;
    if (res.error) {
      if (!isMissingRelationError(res.error)) console.warn('[purchases] list failed:', res.error.message);
      return [];
    }
    return (res.data ?? []).map((row) => parsePurchase(row as Record<string, unknown>));
  } catch (err) {
    console.warn('[purchases] list error:', err);
    return [];
  }
}

/** True when the purchases table exists (0004 applied). */
export async function purchasesAvailable(): Promise<boolean> {
  try {
    const supabase = getSupabase();
    const res = await supabase.from('purchases').select('id', { count: 'exact', head: true }).limit(1);
    if (res.error) return !isMissingRelationError(res.error);
    return true;
  } catch {
    return false;
  }
}

export type PurchaseInput = {
  botId: string;
  visitorId: string;
  title: string;
  amount?: number | null;
  currency?: string;
  status?: PurchaseStatus;
  orderedAt?: string | null;
};

export async function addPurchase(input: PurchaseInput): Promise<PurchaseRow | null> {
  try {
    const supabase = getSupabase();
    const orderedAt =
      input.orderedAt && !Number.isNaN(new Date(input.orderedAt).getTime())
        ? new Date(input.orderedAt).toISOString()
        : new Date().toISOString();
    const res = await supabase
      .from('purchases')
      .insert({
        bot_id: input.botId,
        visitor_id: input.visitorId,
        title: input.title,
        amount: input.amount ?? null,
        currency: input.currency ?? 'RUB',
        status: input.status ?? 'completed',
        ordered_at: orderedAt,
      })
      .select(PURCHASE_COLUMNS)
      .single();
    if (res.error) {
      if (!isMissingRelationError(res.error)) console.warn('[purchases] insert failed:', res.error.message);
      return null;
    }
    return parsePurchase(res.data as Record<string, unknown>);
  } catch (err) {
    console.warn('[purchases] insert error:', err);
    return null;
  }
}

export async function deletePurchase(id: string): Promise<boolean> {
  try {
    const supabase = getSupabase();
    const res = await supabase.from('purchases').delete().eq('id', id);
    if (res.error) {
      if (!isMissingRelationError(res.error)) console.warn('[purchases] delete failed:', res.error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[purchases] delete error:', err);
    return false;
  }
}

export async function updatePurchase(
  id: string,
  patch: { title?: string; amount?: number | null; status?: PurchaseStatus },
): Promise<PurchaseRow | null> {
  try {
    const supabase = getSupabase();
    const res = await supabase.from('purchases').update(patch).eq('id', id).select(PURCHASE_COLUMNS).single();
    if (res.error) {
      if (!isMissingRelationError(res.error)) console.warn('[purchases] update failed:', res.error.message);
      return null;
    }
    return parsePurchase(res.data as Record<string, unknown>);
  } catch (err) {
    console.warn('[purchases] update error:', err);
    return null;
  }
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function money(value: number, currency: string): string {
  const symbol = currency === 'RUB' ? '₽' : currency;
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${symbol}`;
}

/**
 * Сводка для промпта: «2 покупки; последняя — «Пуховик Arctic», 12 900 ₽;
 * всего на 24 400 ₽». Учитываются только «куплено» и «в процессе».
 */
export function summarizePurchases(purchases: PurchaseRow[]): string | null {
  const meaningful = purchases.filter((p) => p.status === 'completed' || p.status === 'pending');
  if (meaningful.length === 0) return null;

  const last = meaningful[0];
  const lastText = last.amount !== null ? `«${last.title}», ${money(last.amount, last.currency)}` : `«${last.title}»`;

  const completed = meaningful.filter((p) => p.status === 'completed');
  const total = completed.reduce((sum, p) => sum + (p.amount ?? 0), 0);
  const totalText =
    completed.length > 0 && total > 0 ? `; всего на ${money(total, completed[0].currency)}` : '';

  return `${meaningful.length} ${plural(meaningful.length, 'покупка', 'покупки', 'покупок')}; последняя — ${lastText}${totalText}`;
}
