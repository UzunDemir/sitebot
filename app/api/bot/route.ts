/**
 * Returns public info about all active bots (key, name, greeting).
 * Consumed by the chat page client-side, so the page itself can stay static.
 */

import { getSupabase } from '@/lib/supabase';

export async function GET(): Promise<Response> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('bots')
      .select('public_key, name, greeting')
      .eq('is_active', true)
      .order('created_at', { ascending: true });
    if (error) throw error;

    if (!data || data.length === 0) {
      return Response.json({ error: 'not_seeded' }, { status: 404 });
    }

    return Response.json({
      bots: data.map((row) => ({
        publicKey: row.public_key,
        name: row.name,
        greeting: row.greeting,
      })),
    });
  } catch (err) {
    console.error('[bot] failed to load bots:', err);
    return Response.json({ error: 'not_configured' }, { status: 500 });
  }
}
