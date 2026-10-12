/**
 * Server-only Supabase client (service role).
 *
 * The browser never talks to Supabase directly; every query goes through
 * the Next.js server. RLS is enabled with no anon policies as a hard backstop.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    const e = env();
    client = createClient(e.supabaseUrl, e.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
