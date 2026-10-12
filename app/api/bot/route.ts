/**
 * Returns public info about the active bot (key, name, greeting).
 * Consumed by the chat page client-side, so the page itself can stay static.
 */

import { connection } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export async function GET(): Promise<Response> {
  // Never prerender/freeze bot info at build time — always read at request time.
  await connection();

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('bots')
      .select('public_key, name, greeting')
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;

    if (!data) {
      return Response.json({ error: 'not_seeded' }, { status: 404 });
    }

    return Response.json({
      publicKey: data.public_key,
      name: data.name,
      greeting: data.greeting,
    });
  } catch (err) {
    console.error('[bot] failed to load bot:', err);
    return Response.json({ error: 'not_configured' }, { status: 500 });
  }
}
