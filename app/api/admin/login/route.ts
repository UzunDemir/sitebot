/**
 * Admin login: ADMIN_SECRET password -> httpOnly session cookie.
 */

import { adminCookieHeader, adminToken, getAdminSecret, isValidPassword } from '@/lib/admin-auth';

export async function POST(req: Request): Promise<Response> {
  const secret = getAdminSecret();
  if (!secret) {
    return Response.json({ error: 'admin_not_configured' }, { status: 500 });
  }

  const body = (await req.json().catch(() => null)) as { password?: string } | null;
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!password || !isValidPassword(password, secret)) {
    return Response.json({ error: 'wrong_password' }, { status: 401 });
  }

  return Response.json(
    { ok: true },
    { headers: { 'Set-Cookie': adminCookieHeader(adminToken(secret)) } },
  );
}
