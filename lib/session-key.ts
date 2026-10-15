/**
 * Widget session key (client-side helper).
 *
 * A visitor's conversation is identified by (bot public key, session key);
 * the key lives in localStorage and travels to the chat API as `sessionKey`.
 *
 * Keys are per-bot (`sitebot_session_<pk>`) so several widgets on one device
 * keep separate dialogs. The legacy shared key (`sitebot_session`) is adopted
 * once when no per-bot key exists — returning visitors keep their dialog
 * after the per-bot upgrade.
 */

export const LEGACY_SESSION_KEY = 'sitebot_session';

export type SessionStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function sessionStorageKey(publicKey: string): string {
  return `sitebot_session_${publicKey}`;
}

export function visitorStorageKey(publicKey: string): string {
  return `sitebot_visitor_${publicKey}`;
}

/** Session id with fallbacks: crypto.randomUUID is missing in insecure
 *  contexts (an https iframe inside an http page) and in old WebViews —
 *  a session key needs uniqueness, not cryptographic randomness. */
export function makeSessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // fall through to the Math.random variant
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Read (or create) the visitor's session key for one bot.
 * One-time migration: when no per-bot key exists yet, the legacy shared key
 * value is adopted so returning visitors continue their existing dialog.
 */
export function readSessionKey(storage: SessionStorage, publicKey: string): string {
  const storageKey = sessionStorageKey(publicKey);
  const existing = storage.getItem(storageKey);
  if (existing) return existing;

  const legacy = storage.getItem(LEGACY_SESSION_KEY) ?? '';
  const key = legacy || makeSessionId();
  storage.setItem(storageKey, key);
  return key;
}

/** Browser wrapper: localStorage may be inaccessible entirely (sandboxed or
 *  third-party-blocked iframe) — then the session lives for this page only.
 *  Never crash the widget over storage. */
export function readBrowserSessionKey(publicKey: string): string {
  try {
    return readSessionKey(window.localStorage, publicKey);
  } catch {
    return makeSessionId();
  }
}

/** Read (or create) the stable visitor key for one bot (sql/0003 card). */
export function readVisitorKey(storage: SessionStorage, publicKey: string): string {
  const storageKey = visitorStorageKey(publicKey);
  const existing = storage.getItem(storageKey);
  if (existing) return existing;
  const key = makeSessionId();
  storage.setItem(storageKey, key);
  return key;
}

export function readBrowserVisitorKey(publicKey: string): string {
  try {
    return readVisitorKey(window.localStorage, publicKey);
  } catch {
    return makeSessionId();
  }
}

/**
 * Полная ротация локальной идентичности (задел для юридического hard-удаления:
 * и сессия, и карточка). Виджет её больше не использует — «Забыть меня» теперь
 * эпоха памяти (rotateSessionKey ниже), память не удаляется.
 */
export function resetBrowserIdentity(publicKey: string): { sessionKey: string; visitorKey: string } {
  const sessionKey = makeSessionId();
  const visitorKey = makeSessionId();
  try {
    window.localStorage.setItem(sessionStorageKey(publicKey), sessionKey);
    window.localStorage.setItem(visitorStorageKey(publicKey), visitorKey);
  } catch {
    // storage unavailable — the fresh pair lives for this page only
  }
  return { sessionKey, visitorKey };
}

/**
 * «Забыть меня» (эпоха памяти, sql/0005): новая беседа при сохранении
 * карточки-архива. Память никогда не удаляется — сервер лишь открывает новую
 * эпоху; виджет меняет только ключ сессии, visitorKey остаётся прежним.
 */
export function rotateSessionKey(publicKey: string): string {
  const sessionKey = makeSessionId();
  try {
    window.localStorage.setItem(sessionStorageKey(publicKey), sessionKey);
  } catch {
    // storage unavailable — the fresh key lives for this page only
  }
  return sessionKey;
}
