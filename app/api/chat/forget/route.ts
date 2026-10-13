/**
 * «Забыть меня»: the visitor erases their card, dialogs and events.
 *
 * POST { botKey, visitorKey, sessionKey? }
 *
 * Idempotent and quiet: unknown visitors answer ok too. Deleting happens
 * server-side (service role); the widget rotates its local keys afterwards.
 */

import { getSupabase } from '@/lib/supabase';
import { deleteVisitorData } from '@/lib/visitors';

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

    await deleteVisitorData(botId, visitorKey, body?.sessionKey?.trim() || undefined);
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[forget] unhandled error:', err);
    return Response.json({ ok: false }, { status: 500 });
  }
}
