/**
 * Admin logout: clears the session cookie.
 */

import { clearAdminCookieHeader } from '@/lib/admin-auth';

export async function POST(): Promise<Response> {
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': clearAdminCookieHeader() } });
}
