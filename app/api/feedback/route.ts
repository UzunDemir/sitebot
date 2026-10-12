/**
 * Public feedback endpoint: 👍/👎 for an assistant message.
 * The message id comes to the client via the `data-feedback` stream part.
 */

import { getSupabase } from '@/lib/supabase';

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => null)) as {
      messageId?: unknown;
      rating?: unknown;
    } | null;

    const messageId =
      typeof body?.messageId === 'number' && Number.isInteger(body.messageId) ? body.messageId : null;
    const rating = body?.rating === 1 || body?.rating === -1 ? (body.rating as 1 | -1) : null;

    if (messageId === null || rating === null) {
      return Response.json({ error: 'bad_request' }, { status: 400 });
    }

    const supabase = getSupabase();
    const message = await supabase
      .from('messages')
      .select('id, role')
      .eq('id', messageId)
      .maybeSingle();
    if (message.error) throw message.error;
    if (!message.data || message.data.role !== 'assistant') {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }

    const ins = await supabase.from('feedback').insert({ message_id: messageId, rating });
    if (ins.error) throw ins.error;

    return Response.json({ ok: true });
  } catch (err) {
    console.error('[feedback] failed:', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
