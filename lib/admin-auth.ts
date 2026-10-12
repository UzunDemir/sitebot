/**
 * Demo-grade admin auth.
 *
 * ADMIN_SECRET (env) is the admin password. A session cookie carries
 * HMAC-SHA256(secret) — stateless, verifiable on every request, no store.
 * Comparisons use timingSafeEqual on fixed-length hex.
 *
 * Read ADMIN_SECRET lazily so public routes never depend on it.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const ADMIN_COOKIE = 'sitebot_admin';

export function getAdminSecret(): string | null {
  const value = process.env.ADMIN_SECRET;
  return value && value.trim() ? value : null;
}

export function adminToken(secret: string): string {
  return createHmac('sha256', secret).update('sitebot-admin-session-v1').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function isValidAdminToken(token: string | undefined, secret: string): boolean {
  if (!token) return false;
  return safeEqualHex(token, adminToken(secret));
}

/** Password check: compares HMACs (constant length) instead of raw strings. */
export function isValidPassword(password: string, secret: string): boolean {
  return safeEqualHex(adminToken(password), adminToken(secret));
}

export function parseCookie(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return undefined;
}

export function isAdminRequest(req: Request): boolean {
  const secret = getAdminSecret();
  if (!secret) return false;
  const token = parseCookie(req.headers.get('cookie') ?? '', ADMIN_COOKIE);
  return isValidAdminToken(token, secret);
}

export function adminCookieHeader(token: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`;
}

export function clearAdminCookieHeader(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

/**
 * Route guard: returns a Response to short-circuit, or null when the
 * request is an authenticated admin call.
 */
export function adminGuard(req: Request): Response | null {
  if (!getAdminSecret()) {
    return Response.json({ error: 'admin_not_configured' }, { status: 500 });
  }
  if (!isAdminRequest(req)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}
