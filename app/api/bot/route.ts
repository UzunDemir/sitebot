/**
 * Public bot info for the chat page, the embed widget and loader.js.
 *
 * Without ?key= — the list of active bots (main page switcher).
 * With ?key=    — that single bot + theme, subject to the optional
 *                 origin allowlist (checked against the Referer header;
 *                 a basic measure, not spoof-proof).
 *
 * CORS is open (*): loader.js reads the theme from arbitrary host sites.
 * The payload is public by design — the same data is rendered by /embed.
 *
 * Runs strictly at request time — GET handlers must not be prerendered.
 */

import { connection } from 'next/server';
import { getSupabase } from '@/lib/supabase';

const CORS_HEADERS: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };

type BotRow = {
  public_key: string;
  name: string;
  greeting: string | null;
  theme: Record<string, unknown> | null;
  allowed_origins: string[] | null;
};

function refererOrigin(req: Request): string | null {
  const referer = req.headers.get('referer');
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function json(status: number, payload: unknown): Response {
  return Response.json(payload, { status, headers: CORS_HEADERS });
}

/** Next.js uses NEXT_* digest errors to control prerendering — never swallow them. */
function isNextInternalError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'digest' in err &&
      String((err as { digest?: unknown }).digest ?? '').startsWith('NEXT_'),
  );
}

export async function GET(req: Request): Promise<Response> {
  await connection();

  try {
    const supabase = getSupabase();
    const key = new URL(req.url).searchParams.get('key')?.trim() ?? '';

    let query = supabase
      .from('bots')
      .select('public_key, name, greeting, theme, allowed_origins')
      .eq('is_active', true);
    if (key) query = query.eq('public_key', key);

    const { data, error } = await query.order('created_at', { ascending: true });
    if (error) throw error;

    if (!data || data.length === 0) {
      return json(404, { error: key ? 'not_found' : 'not_seeded' });
    }

    if (key) {
      const bot = data[0] as BotRow;
      const allowed = Array.isArray(bot.allowed_origins) ? bot.allowed_origins : [];
      const origin = refererOrigin(req);
      const selfOrigin = new URL(req.url).origin;
      if (allowed.length > 0 && origin && origin !== selfOrigin && !allowed.includes(origin)) {
        return json(403, { error: 'origin_not_allowed' });
      }
    }

    return json(200, {
      bots: (data as BotRow[]).map((row) => ({
        publicKey: row.public_key,
        name: row.name,
        greeting: row.greeting,
        theme: row.theme ?? {},
      })),
    });
  } catch (err) {
    if (isNextInternalError(err)) throw err;
    console.error('[bot] failed to load bots:', err);
    return json(500, { error: 'not_configured' });
  }
}
