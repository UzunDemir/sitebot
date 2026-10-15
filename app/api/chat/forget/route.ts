/**
 * «Забыть меня»: не удаление, а новая эпоха памяти (sql/0005_memory_reset.sql).
 *
 * Память посетителя никогда не удаляется: POST ставит маркер memory_resets —
 * активная память бота начинается заново (карточка чистится, контекст модели
 * строится только с этого момента), а архив (беседы, события, покупки)
 * остаётся у владельца для анализа и стратегий.
 *
 * POST { botKey, visitorKey, sessionKey? }
 *
 * Идемпотентно и тихо: неизвестный посетитель тоже получает ok. Локальные
 * ключи виджета ротирует клиент: новая беседа, та же карточка-архив.
 */

import { getSupabase } from '@/lib/supabase';
import { softResetVisitor } from '@/lib/memory-window';

type ForgetBody = {
  botKey?: string;
  visitorKey?: string;
  sessionKey?: string;
};

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => null)) as ForgetBody | null;
    const botKey = body?.botKey?.trim() ?? '';
    const visitorKey = body?.visitorKey?.trim() ?? '';
    if (!botKey || !visitorKey) {
      return Response.json({ error: 'bad_request' }, { status: 400 });
    }

    const supabase = getSupabase();
    const botRes = await supabase
      .from('bots')
      .select('id')
      .eq('public_key', botKey)
      .eq('is_active', true)
      .maybeSingle();
    if (botRes.error) throw botRes.error;
    const botId = (botRes.data?.id as string | undefined) ?? null;
    if (!botId) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }

    const result = await softResetVisitor({
      botId,
      visitorKey,
      source: 'button',
      sessionKey: body?.sessionKey?.trim() || undefined,
    });
    return Response.json({ ok: result.ok, mode: 'soft' });
  } catch (err) {
    console.error('[forget] unhandled error:', err);
    return Response.json({ ok: false }, { status: 500 });
  }
}
