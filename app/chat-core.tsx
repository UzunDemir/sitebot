'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { WidgetTheme } from '@/lib/widget-theme';
import { readBrowserSessionKey, readBrowserVisitorKey, rotateSessionKey } from '@/lib/session-key';

export type ChatBotInfo = {
  publicKey: string;
  name: string;
  greeting: string | null;
  theme?: WidgetTheme;
};

export const DEFAULT_ACCENT = '#4f46e5';

type SourceItem = {
  n: number;
  title: string | null;
  source: string | null;
  similarity: number | null;
};

type FeedbackInfo = { messageId: number | null; rating?: number };

/** Nudge config delivered by GET /api/chat/history (Ф3). */
type NudgesConfig = {
  enabled: boolean;
  attempts: number;
  firstDelaySec: number;
  intervalSec: number;
  quietHours: { enabled: boolean; from: string; to: string };
};

function messageText(parts: unknown[]): string {
  return parts
    .map((part) => {
      const p = part as { type: string; text?: string };
      return p.type === 'text' ? p.text ?? '' : '';
    })
    .join('');
}

function sourcesFromParts(parts: unknown[]): SourceItem[] {
  const part = parts.find((p) => (p as { type: string }).type === 'data-sources') as
    | { data?: { items?: SourceItem[] } }
    | undefined;
  return part?.data?.items ?? [];
}

function feedbackFromParts(parts: unknown[]): FeedbackInfo | null {
  const part = parts.find((p) => (p as { type: string }).type === 'data-feedback') as
    | { data?: FeedbackInfo }
    | undefined;
  return part?.data ?? null;
}

function proactiveFromParts(parts: unknown[]): boolean {
  return parts.some((part) => (part as { type: string }).type === 'data-proactive');
}

type Palette = {
  accent: string;
  pageBg: string;
  headerBg: string;
  headerText: string;
  headerSubtle: string;
  botBubbleBg: string;
  botBubbleText: string;
  userBubbleBg: string;
  userBubbleText: string;
  border: string;
  subtleText: string;
  inputBg: string;
  typingDots: string;
  radius: number;
};

function paletteOf(t: WidgetTheme): Palette {
  const dark = t.dark === true;
  const c = t.colors ?? {};
  const accent = t.accent || DEFAULT_ACCENT;
  return {
    accent,
    pageBg: c.pageBg || (dark ? '#0f172a' : '#ffffff'),
    headerBg: c.headerBg || (dark ? '#1e293b' : '#ffffff'),
    headerText: c.headerText || (dark ? '#f1f5f9' : '#0f172a'),
    headerSubtle: dark ? '#94a3b8' : '#64748b',
    botBubbleBg: c.botBubbleBg || (dark ? '#1e293b' : '#f1f5f9'),
    botBubbleText: c.botBubbleText || (dark ? '#e2e8f0' : '#1e293b'),
    userBubbleBg: c.userBubbleBg || accent,
    userBubbleText: c.userBubbleText || '#ffffff',
    border: dark ? '#334155' : '#e2e8f0',
    subtleText: dark ? '#64748b' : '#94a3b8',
    inputBg: c.inputBg || (dark ? '#0f172a' : '#ffffff'),
    typingDots: c.typingDots || (dark ? '#94a3b8' : '#64748b'),
    radius: Math.min(28, Math.max(0, t.radius ?? 16)),
  };
}

/**
 * Три бегущие точки — «бот печатает». Цвет, размер точки, высота прыжка и
 * скорость цикла настраиваются в теме виджета (theme.typingDots*).
 */
function TypingDots({
  color,
  size,
  jump,
  speed,
  label,
  mode,
}: {
  color: string;
  size: number;
  jump: number;
  speed: number;
  label: string;
  /** jump — прыгают вверх-вниз; run — волна слева направо (как в Viber). */
  mode: 'jump' | 'run';
}) {
  const stagger = Math.max(60, Math.round(speed / 6));
  return (
    <span className="inline-flex items-center gap-2" role="status" aria-label="Бот печатает">
      {label ? (
        <span style={{ color }}>{label}</span>
      ) : null}
      <span
        className="inline-flex items-end gap-1"
        style={{
          height: mode === 'run' ? size : size + jump,
          ...({ '--sitebot-dot-jump': `${jump}px` } as CSSProperties),
        }}
      >
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="rounded-full"
            style={
              mode === 'run'
                ? {
                    width: size,
                    height: size,
                    backgroundColor: color,
                    // Как в Viber: волна слева направо — точки по очереди
                    // вспыхивают, оставаясь на месте.
                    animation: `sitebot-dot-wave ${speed}ms ease-in-out infinite`,
                    animationDelay: `${index * Math.round(speed / 3)}ms`,
                  }
                : {
                    width: size,
                    height: size,
                    backgroundColor: color,
                    animation: `sitebot-dot-jump ${speed}ms ease-in-out infinite`,
                    animationDelay: `${index * stagger}ms`,
                  }
            }
          />
        ))}
      </span>
    </span>
  );
}

/** IANA-таймзона браузера — «осознание времени» на сервере (Ф3). */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

export function Chat({
  bot,
  theme,
  compact = false,
}: {
  bot: ChatBotInfo;
  theme?: WidgetTheme;
  compact?: boolean;
}) {
  const t: WidgetTheme = { ...(bot.theme ?? {}), ...(theme ?? {}) };
  const p = paletteOf(t);
  // Индикатор «печатает»: размер точек, высота прыжка и скорость — из темы.
  const dotsSize = t.typingDotsSize ?? 5;
  const dotsJump = t.typingDotsJump ?? 3;
  const dotsSpeed = t.typingDotsSpeed ?? 900;
  const dotsLabel = t.typingLabel ?? 'Печатает';
  const dotsMode = t.typingDotsMode ?? 'jump';
  const title = t.title || bot.name;
  const subtitle = t.subtitle || 'Отвечает по базе знаний, с источниками';
  const [input, setInput] = useState('');
  const [sessionKey, setSessionKey] = useState('');
  const [visitorKey, setVisitorKey] = useState('');
  const [visitor, setVisitor] = useState<{ name: string | null; returning: boolean } | null>(null);
  const [forget, setForget] = useState<0 | 1 | 2>(0);
  const [liveNudges, setLiveNudges] = useState<string[]>([]);
  // Перезапуск движка дожима после ответа посетителя (серия — заново).
  const [engineEpoch, setEngineEpoch] = useState(0);
  const [inFrame, setInFrame] = useState(false);
  // Непрочитанные касания при ОТКРЫТОМ окне — кружок в шапке (сбрасывается
  // ответом посетителя или кликом по кружку).
  const [openUnread, setOpenUnread] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Dialog engine refs (survive effect re-runs; read at tick time).
  const nudgesRef = useRef<NudgesConfig | null>(null);
  const nudgesSentRef = useRef(0);
  const outcomeRef = useRef('in_progress');
  // Unread badge (embed mode): touches received while the window is collapsed.
  const chatOpenRef = useRef(true);
  const unreadNudgesRef = useRef(0);
  const lastNudgeIdRef = useRef<number | null>(null);

  // Optional web font for the widget (link is scoped to this document).
  useEffect(() => {
    if (!t.fontUrl) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = t.fontUrl;
    document.head.appendChild(link);
    return () => {
      document.head.removeChild(link);
    };
  }, [t.fontUrl]);

  useEffect(() => {
    // Per-bot keys: session (dialog) and visitor (card, sql/0003).
    // The legacy shared session key is adopted once so existing visitors
    // continue their conversation after this upgrade.
    setSessionKey(readBrowserSessionKey(bot.publicKey));
    setVisitorKey(readBrowserVisitorKey(bot.publicKey));
  }, [bot.publicKey]);

  useEffect(() => {
    // In widget mode (host-page iframe) we can ask the loader to
    // collapse the chat window via postMessage.
    setInFrame(window.parent !== window);
  }, []);

  // Курсор всегда готов к вводу: фокус при открытии окна; после каждого
  // ответа — эффект рядом с useChat (там появляется status).
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const draggable = compact && inFrame;

  function onHeaderPointerDown(e: ReactPointerEvent<HTMLElement>) {
    if (!draggable) return;
    if ((e.target as HTMLElement).closest('button')) return;
    // Screen coordinates: clientX lives in the iframe viewport, which
    // moves together with the window — deltas would oscillate (jitter).
    dragRef.current = { x: e.screenX, y: e.screenY };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // pointer capture unsupported — drag still works inside the frame
    }
  }

  function onHeaderPointerMove(e: ReactPointerEvent<HTMLElement>) {
    if (!draggable || !dragRef.current) return;
    const dx = e.screenX - dragRef.current.x;
    const dy = e.screenY - dragRef.current.y;
    if (dx === 0 && dy === 0) return;
    dragRef.current = { x: e.screenX, y: e.screenY };
    try {
      window.parent.postMessage({ type: 'sitebot:move', dx, dy }, '*');
    } catch {
      // ignore
    }
  }

  function onHeaderPointerUp() {
    dragRef.current = null;
  }

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        body: { botKey: bot.publicKey, sessionKey, visitorKey, tz: browserTimeZone() },
      }),
    [bot.publicKey, sessionKey, visitorKey],
  );

  const { messages, sendMessage, setMessages, status, error } = useChat({ transport });

  // После каждого ответа бота (статус снова 'ready') возвращаем курсор в
  // поле ввода — посетитель может печатать сразу.
  useEffect(() => {
    if (status === 'ready') inputRef.current?.focus({ preventScroll: true });
  }, [status]);

  // Memory lives on the server: the dialog is stored per bot + session and
  // the model reads it from the DB (the widget never replays the past chat —
  // the feed starts clean). This fetch only supplies the welcome-back
  // greeting (visitor card) and the dialog-engine state (Ф3). Best effort:
  // a failed fetch never blocks the chat.
  useEffect(() => {
    if (!sessionKey || !visitorKey) return;
    let cancelled = false;
    let retryTimer: number | null = null;

    async function load(): Promise<void> {
      try {
        const res = await fetch(
          `/api/chat/history?botKey=${encodeURIComponent(bot.publicKey)}&sessionKey=${encodeURIComponent(sessionKey)}&visitorKey=${encodeURIComponent(visitorKey)}&limit=1`,
        );
        if (!res.ok) throw new Error(`history HTTP ${res.status}`);
        const payload = (await res.json().catch(() => null)) as {
          visitor?: { name?: unknown; returning?: unknown } | null;
          nudges?: Partial<NudgesConfig> | null;
          nudgesSent?: unknown;
          outcome?: unknown;
        } | null;
        if (cancelled) return;
        const info = payload?.visitor;
        if (info && info.returning === true) {
          setVisitor({
            name: typeof info.name === 'string' && info.name.trim() ? info.name.trim() : null,
            returning: true,
          });
        }
        // Dialog-engine state (Ф3): server-resolved config + counters.
        const nudgesInfo = payload?.nudges;
        if (nudgesInfo && typeof nudgesInfo === 'object') {
          nudgesRef.current = {
            enabled: nudgesInfo.enabled !== false,
            attempts: typeof nudgesInfo.attempts === 'number' ? nudgesInfo.attempts : 0,
            firstDelaySec:
              typeof nudgesInfo.firstDelaySec === 'number' ? nudgesInfo.firstDelaySec : 45,
            intervalSec: typeof nudgesInfo.intervalSec === 'number' ? nudgesInfo.intervalSec : 300,
            quietHours:
              nudgesInfo.quietHours ?? { enabled: false, from: '21:00', to: '09:00' },
          };
        }
        if (typeof payload?.nudgesSent === 'number') nudgesSentRef.current = payload.nudgesSent;
        if (typeof payload?.outcome === 'string') outcomeRef.current = payload.outcome;
      } catch {
        // Из этого ответа движок дожима получает конфиг — одна сетевая
        // ошибка не должна глушить дожим: тихо повторяем, пока не ответит.
        if (!cancelled) retryTimer = window.setTimeout(() => void load(), 20_000);
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [sessionKey, visitorKey, bot.publicKey]);

  // Funnel analytics (sql/0003): one session_start per page, then
  // page_hidden when the visitor leaves. Fire-and-forget — never blocks.
  const sessionStartedRef = useRef(false);
  useEffect(() => {
    if (!sessionKey || !visitorKey || sessionStartedRef.current) return;
    sessionStartedRef.current = true;
    void fetch('/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botKey: bot.publicKey, sessionKey, visitorKey, type: 'session_start' }),
    }).catch(() => {
      // analytics only; ignore
    });
  }, [sessionKey, visitorKey, bot.publicKey]);

  useEffect(() => {
    if (!sessionKey || !visitorKey) return;
    const payload = JSON.stringify({
      botKey: bot.publicKey,
      sessionKey,
      visitorKey,
      type: 'page_hidden',
    });
    let lastHiddenAt = 0;
    function sendHidden() {
      const now = Date.now();
      if (now - lastHiddenAt < 60_000) return; // throttle: no spam on quick tab flips
      lastHiddenAt = now;
      try {
        void fetch('/api/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      } catch {
        // ignore
      }
    }
    function onVisibility() {
      if (document.visibilityState === 'hidden') sendHidden();
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', sendHidden);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', sendHidden);
    };
  }, [sessionKey, visitorKey, bot.publicKey]);

  // Embed mode: the loader reports when the chat window is collapsed or
  // expanded, so touches received while collapsed count as unread (badge).
  useEffect(() => {
    function onParentMessage(event: MessageEvent) {
      if (event.source !== window.parent) return;
      const data = event.data as { type?: string } | null;
      if (!data) return;
      if (data.type === 'sitebot:chat-opened') {
        chatOpenRef.current = true;
        unreadNudgesRef.current = 0;
        setOpenUnread(0);
        window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 60);
        try {
          window.parent.postMessage({ type: 'sitebot:unread', count: 0 }, '*');
        } catch {
          // ignore
        }
      } else if (data.type === 'sitebot:chat-closed') {
        chatOpenRef.current = false;
      }
    }
    window.addEventListener('message', onParentMessage);
    return () => window.removeEventListener('message', onParentMessage);
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, status]);

  const busy = status === 'submitted' || status === 'streaming';

  // --- Dialog engine (Ф3): proactive touches for a silent visitor.
  // The server is the single source of truth (enabled, DND, quiet hours,
  // attempt limit, timing, goal state); the client only displays what the
  // server allows — in-feed and, when embedded, via the loader teaser.
  // Hard stops: DND / disabled. A visitor answer resets the series (submit)
  // and resumes the loop; hidden tabs do not block touches — the message
  // waits in the dialog until the visitor returns.
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    if (!sessionKey || !visitorKey) return;
    let cancelled = false;
    let timer: number | null = null;

    const arm = (delayMs: number) => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void tick();
      }, Math.max(5_000, delayMs));
    };

    async function tick(): Promise<void> {
      if (cancelled) return;
      const config = nudgesRef.current;
      if (!config) {
        arm(20_000); // config arrives with the history fetch
        return;
      }
      if (!config.enabled || config.attempts <= 0) return; // hard stop
      if (nudgesSentRef.current >= config.attempts) return;
      // Терминальные диалоги не трогаем; 'lost' — можно: сервер разрешит
      // одно реактивационное касание, а новое сообщение оживит беседу.
      if (outcomeRef.current === 'goal_reached' || outcomeRef.current === 'stopped') return;
      if (busyRef.current) {
        arm(25_000);
        return;
      }

      let tz = '';
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
      } catch {
        // no timezone — the server falls back to timezone-less checks
      }

      try {
        const res = await fetch('/api/chat/nudge', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ botKey: bot.publicKey, sessionKey, visitorKey, tz }),
        });
        if (cancelled) return;
        const payload = (await res.json().catch(() => null)) as {
          allowed?: boolean;
          reason?: string;
          text?: string;
          nudgeNumber?: number;
          messageId?: number | null;
          retryAfterMs?: number;
          nextAllowedAt?: string;
        } | null;

        if (payload?.allowed === true && typeof payload.text === 'string' && payload.text) {
          const nudgeText = payload.text;
          const attempt = payload.nudgeNumber ?? nudgesSentRef.current + 1;
          nudgesSentRef.current = attempt;
          const messageId = typeof payload.messageId === 'number' ? payload.messageId : null;
          if (messageId === null || messageId !== lastNudgeIdRef.current) {
            lastNudgeIdRef.current = messageId;
            // Касание остаётся в ленте до ответа посетителя (как сообщение).
            setLiveNudges((current) => [...current, nudgeText].slice(-6));
          }
          try {
            window.parent.postMessage({ type: 'sitebot:nudge', text: nudgeText }, '*');
          } catch {
            // not embedded — the in-feed bubble is enough
          }
          if (!chatOpenRef.current) {
            unreadNudgesRef.current += 1;
            try {
              window.parent.postMessage({ type: 'sitebot:unread', count: unreadNudgesRef.current }, '*');
            } catch {
              // not embedded — no badge to update
            }
          } else {
            // Окно открыто: касание не должно потеряться — считаем и показываем
            // кружок в шапке (клик — к последним сообщениям, счётчик сброшен).
            setOpenUnread((count) => count + 1);
          }
          const gapSec = attempt <= 0 ? config.firstDelaySec : config.intervalSec * Math.pow(2, attempt - 1);
          arm(gapSec * 1000);
          return;
        }

        switch (payload?.reason) {
          case 'too_early':
            arm(payload.retryAfterMs ?? 30_000);
            return;
          case 'quiet_hours': {
            const until = payload.nextAllowedAt
              ? new Date(payload.nextAllowedAt).getTime() - Date.now()
              : 10 * 60_000;
            arm(until);
            return;
          }
          case 'limit':
          case 'closed':
            // Касаний пока не положено (лимит или пауза диалога) — не
            // «умираем»: ответ посетителя сбросит счётчик и серия продолжится.
            arm(120_000);
            return;
          case 'dnd':
          case 'disabled':
          case 'no_dialog':
            return; // hard stop until the next page load
          default:
            arm(60_000);
            return;
        }
      } catch {
        arm(5 * 60_000);
      }
    }

    arm(20_000);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [sessionKey, visitorKey, bot.publicKey, engineEpoch]);

  const errorText = (() => {
    if (!error) return null;
    try {
      const parsed = JSON.parse(error.message) as { message?: string; error?: string };
      if (parsed?.message) return parsed.message;
      if (parsed?.error === 'quota_exceeded') return 'Дневной лимит бота исчерпан. Попробуйте позже.';
    } catch {
      // not a JSON error body
    }
    return 'Не удалось получить ответ. Попробуйте ещё раз.';
  })();

  function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    // Касания остаются в ленте: перед ответом переносим их в сообщения
    // (в истории они придут из БД с тем же текстом и пометкой).
    if (liveNudges.length > 0) {
      const merged: UIMessage[] = liveNudges.map((nudgeText, index) => ({
        id: `nudge-local-${lastNudgeIdRef.current ?? 'x'}-${index}`,
        role: 'assistant',
        parts: [
          { type: 'text', text: nudgeText },
          { type: 'data-proactive', id: 'proactive', data: {} },
        ],
      }));
      setMessages((current) => [...current, ...merged]);
      setLiveNudges([]);
    }
    lastNudgeIdRef.current = null;
    nudgesSentRef.current = 0;
    setOpenUnread(0);
    // Ответ посетителя оживляет диалог: 'lost' и 'goal_reached' сервер
    // открывает заново (цель можно достичь повторно), 'stopped' — нет.
    if (outcomeRef.current === 'lost' || outcomeRef.current === 'goal_reached') {
      outcomeRef.current = 'in_progress';
    }
    // Перезапуск движка: серия касаний сброшена — окно ожидания открывается
    // заново (иначе после исчерпанной серии движок молчал бы до перезагрузки).
    setEngineEpoch((value) => value + 1);
    sendMessage({ text });
    setInput('');
  }

  // Two-step «забыть меня»: сервер открывает новую эпоху памяти (память не
  // удаляется — архив остаётся у владельца), виджет начинает новую беседу с
  // той же карточкой-архивом: sessionKey новый, visitorKey сохраняем.
  async function confirmForget() {
    if (!visitorKey) return;
    try {
      await fetch('/api/chat/forget', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ botKey: bot.publicKey, visitorKey, sessionKey }),
      });
    } catch {
      // even if the request fails, start the fresh dialog locally
    }
    const freshSession = rotateSessionKey(bot.publicKey);
    sessionStartedRef.current = false;
    setMessages([]);
    setVisitor(null);
    setLiveNudges([]);
    lastNudgeIdRef.current = null;
    unreadNudgesRef.current = 0;
    nudgesSentRef.current = 0;
    outcomeRef.current = 'in_progress';
    setSessionKey(freshSession);
    setForget(2);
    window.setTimeout(() => setForget(0), 4000);
  }

  /** Клик по ленте возвращает курсор в поле ввода (не мешая выделению текста). */
  function focusInput() {
    try {
      const selection = window.getSelection();
      if (selection && selection.isCollapsed === false) return;
    } catch {
      // ignore
    }
    inputRef.current?.focus({ preventScroll: true });
  }

  /** Переход к непрочитанным касаниям: скролл к первому из них + сброс кружка. */
  function jumpToUnread() {
    const list = listRef.current;
    const count = openUnread;
    setOpenUnread(0);
    // Курсор — в поле ввода: после перехода к непрочитанным можно сразу писать.
    inputRef.current?.focus({ preventScroll: true });
    if (!list) return;
    if (count > 0) {
      const bubbles = list.querySelectorAll<HTMLElement>('[data-nudge-bubble]');
      if (bubbles.length > 0) {
        bubbles[Math.max(0, bubbles.length - count)].scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
        return;
      }
    }
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }

  const bubbleRadius = p.radius;
  // Пока ассистентского сообщения в ленте ещё нет — отдельный пузырь с
  // точками на месте будущего ответа (позже точки переедут внутрь пузыря).
  const lastMessage = messages[messages.length - 1];
  const awaitingAssistant =
    status === 'submitted' && (!lastMessage || lastMessage.role === 'user');
  const greetingText = visitor?.returning
    ? visitor.name
      ? `С возвращением, ${visitor.name}!`
      : 'С возвращением! Продолжим с того места, где остановились.'
    : bot.greeting ?? 'Здравствуйте! Чем могу помочь?';

  return (
    <div
      className={`flex flex-col overflow-hidden ${compact ? 'h-full' : 'h-[85vh]'}`}
      style={{
        backgroundColor: p.pageBg,
        borderRadius: compact ? 0 : bubbleRadius,
        border: compact ? 'none' : `1px solid ${p.border}`,
        boxShadow: compact ? 'none' : '0 1px 2px rgba(15, 23, 42, 0.06)',
        ...(t.fontFamily ? { fontFamily: t.fontFamily } : {}),
      }}
    >
      <header
        className="flex items-center gap-3 border-b px-5 py-4"
        style={{
          backgroundColor: p.headerBg,
          borderColor: p.border,
          ...(draggable ? { cursor: 'grab', touchAction: 'none' } : {}),
        }}
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
        onDoubleClick={() => {
          if (!draggable) return;
          try {
            window.parent.postMessage({ type: 'sitebot:move-reset' }, '*');
          } catch {
            // ignore
          }
        }}
      >
        <div className="relative shrink-0">
          {t.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={t.avatarUrl} alt="" className="h-9 w-9 rounded-full object-cover" />
          ) : (
            <div
              className="flex h-9 w-9 items-center justify-center rounded-full text-lg text-white"
              style={{ backgroundColor: p.accent }}
            >
              💬
            </div>
          )}
          {/* Непрочитанные касания: красный кружок поверх аватара — как бейдж
              свёрнутого окна (красный, белая обводка, тень). Клик — переход
              к непрочитанным и сброс счётчика. */}
          {openUnread > 0 && (
            <button
              type="button"
              onClick={jumpToUnread}
              title="Новые сообщения — перейти"
              aria-label={`Непрочитанных сообщений: ${openUnread}`}
              className="absolute -right-2 -top-2 z-10 flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold text-white"
              style={{
                backgroundColor: '#ef4444',
                border: '2px solid #ffffff',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.28)',
                boxSizing: 'border-box',
                lineHeight: 1,
              }}
            >
              {openUnread > 9 ? '9+' : openUnread}
            </button>
          )}
        </div>
        <div>
          <h1 className="text-sm font-semibold" style={{ color: p.headerText }}>
            {title}
          </h1>
          {!compact && (
            <p className="text-xs" style={{ color: p.headerSubtle }}>
              {subtitle}
            </p>
          )}
        </div>
        <span
          className={`ml-auto inline-flex h-2.5 w-2.5 rounded-full ${busy ? 'bg-amber-400' : 'bg-emerald-500'}`}
          title={busy ? 'Генерирую ответ' : 'Готов'}
        />
        {compact && inFrame && (
          <button
            type="button"
            aria-label="Свернуть чат"
            title="Свернуть"
            onClick={() => {
              try {
                window.parent.postMessage({ type: 'sitebot:minimize' }, '*');
              } catch {
                // ignore
              }
            }}
            className="-mr-1 ml-1 flex h-10 w-10 items-center justify-center rounded-full text-2xl leading-none opacity-70 transition-opacity hover:opacity-100"
            style={{ color: p.headerText }}
          >
            ▾
          </button>
        )}
      </header>

      <div ref={listRef} onClick={focusInput} className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
        <div className="flex justify-start">
          <div
            className="max-w-[85%] px-4 py-3 text-sm whitespace-pre-wrap"
            style={{
              backgroundColor: p.botBubbleBg,
              color: p.botBubbleText,
              borderRadius: bubbleRadius,
              borderBottomLeftRadius: 6,
            }}
          >
            {greetingText}
          </div>
        </div>

        {messages.map((message) => {
          const text = messageText(message.parts);
          const sources = sourcesFromParts(message.parts);
          const feedback = feedbackFromParts(message.parts);
          const proactive = proactiveFromParts(message.parts);
          const isLastMessage = message.id === messages[messages.length - 1]?.id;
          // Ответ пишется прямо на месте точек: пока текста нет, точки бегут
          // в ЭТОМ пузыре, с первым токеном текст заменяет их.
          const showDotsHere =
            (status === 'submitted' || status === 'streaming') && text === '' && isLastMessage;

          if (message.role === 'user') {
            return (
              <div key={message.id} className="flex justify-end">
                <div
                  className="max-w-[85%] px-4 py-3 text-sm whitespace-pre-wrap"
                  style={{
                    backgroundColor: p.userBubbleBg,
                    color: p.userBubbleText,
                    borderRadius: bubbleRadius,
                    borderBottomRightRadius: 6,
                  }}
                >
                  {text}
                </div>
              </div>
            );
          }

          return (
            <div key={message.id} className="flex justify-start">
              <div className="max-w-[85%] space-y-2">
                {proactive && (
                  <span className="block pl-1 text-[10px]" style={{ color: p.subtleText }}>
                    Бот написал сам
                  </span>
                )}
                <div
                  className="px-4 py-3 text-sm whitespace-pre-wrap"
                  style={{
                    backgroundColor: p.botBubbleBg,
                    color: p.botBubbleText,
                    borderRadius: bubbleRadius,
                    borderBottomLeftRadius: 6,
                  }}
                >
                  {showDotsHere ? (
                    <TypingDots
                      color={p.typingDots}
                      size={dotsSize}
                      jump={dotsJump}
                      speed={dotsSpeed}
                      label={dotsLabel}
                      mode={dotsMode}
                    />
                  ) : (
                    text
                  )}
                </div>
                {sources.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {sources.map((s) => (
                      <span
                        key={s.n}
                        className="inline-flex items-center gap-1 border px-2.5 py-1 text-[11px]"
                        style={{
                          borderColor: p.border,
                          color: p.headerSubtle,
                          backgroundColor: p.headerBg,
                          borderRadius: 999,
                        }}
                        title={s.source ?? undefined}
                      >
                        [{s.n}] {s.title ?? 'источник'}
                      </span>
                    ))}
                  </div>
                )}
                {!busy && text && <FeedbackButtons info={feedback} />}
              </div>
            </div>
          );
        })}

        {liveNudges.length > 0 && !busy && (
          <div className="space-y-3">
            {liveNudges.map((nudgeText, index) => (
              <div key={`nudge-${index}`} className="flex justify-start">
                <div className="max-w-[85%] space-y-1">
                  <span className="block pl-1 text-[10px]" style={{ color: p.subtleText }}>
                    Бот написал сам
                  </span>
                  <div
                    data-nudge-bubble
                    className="px-4 py-3 text-sm whitespace-pre-wrap"
                    style={{
                      backgroundColor: p.botBubbleBg,
                      color: p.botBubbleText,
                      borderRadius: bubbleRadius,
                      borderBottomLeftRadius: 6,
                      outline: `1px dashed ${p.border}`,
                      outlineOffset: 2,
                    }}
                  >
                    {nudgeText}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {awaitingAssistant && (
          <div className="flex justify-start">
            <div
              className="px-4 py-3 text-sm"
              style={{
                backgroundColor: p.botBubbleBg,
                color: p.botBubbleText,
                borderRadius: bubbleRadius,
                borderBottomLeftRadius: 6,
              }}
            >
              <TypingDots
                color={p.typingDots}
                size={dotsSize}
                jump={dotsJump}
                speed={dotsSpeed}
                label={dotsLabel}
                mode={dotsMode}
              />
            </div>
          </div>
        )}

        {errorText && (
          <div
            className="border px-4 py-3 text-sm"
            style={{ borderColor: '#fecaca', backgroundColor: '#fef2f2', color: '#b91c1c', borderRadius: bubbleRadius }}
          >
            {errorText}
          </div>
        )}
      </div>

      <form
        onSubmit={submit}
        className="border-t px-4 py-3"
        style={{
          borderColor: p.border,
          backgroundColor: p.headerBg,
          ...(compact ? { paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' } : {}),
        }}
      >
        <div className="flex gap-2">
          <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Спросите что-нибудь…"
          className="flex-1 px-4 py-2.5 text-sm outline-none"
          style={{
            backgroundColor: p.inputBg,
            border: `1px solid ${p.border}`,
            borderRadius: bubbleRadius,
            color: p.headerText,
          }}
          maxLength={1000}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          style={{ backgroundColor: p.accent, borderRadius: bubbleRadius }}
        >
          {busy ? '…' : 'Отправить'}
        </button>
        </div>
        <div
          className="mt-1.5 flex min-h-[16px] items-center justify-end gap-2 text-[10px]"
          style={{ color: p.subtleText }}
        >
          {forget === 0 && (
            <button
              type="button"
              onClick={() => setForget(1)}
              className="opacity-60 transition-opacity hover:opacity-100"
            >
              Забыть меня
            </button>
          )}
          {forget === 1 && (
            <>
              <span>Забыть вас и начать с чистого листа?</span>
              <button
                type="button"
                onClick={() => void confirmForget()}
                className="font-medium text-red-600 underline"
              >
                Да, забыть
              </button>
              <button type="button" onClick={() => setForget(0)} className="opacity-60 hover:opacity-100">
                Отмена
              </button>
            </>
          )}
          {forget === 2 && <span>Готово — начинаем с чистого листа.</span>}
        </div>
      </form>
    </div>
  );
}

function FeedbackButtons({ info }: { info: FeedbackInfo | null }) {
  // A rating restored from history shows as already sent (no re-vote).
  const [sent, setSent] = useState<0 | 1 | -1>(
    info?.rating === 1 ? 1 : info?.rating === -1 ? -1 : 0,
  );
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!info?.messageId) return null;

  async function rate(rating: 1 | -1) {
    if (busy || sent !== 0) return;
    setBusy(true);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: info?.messageId, rating }),
      });
      if (res.ok) {
        setSent(rating);
        setFresh(true);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-1.5 pl-1">
      <button
        type="button"
        onClick={() => void rate(1)}
        disabled={busy || sent !== 0}
        title="Полезный ответ"
        className={`rounded px-1.5 py-0.5 text-xs transition-opacity ${
          sent === 1 ? 'opacity-100' : 'opacity-50 hover:opacity-90'
        } ${sent === -1 ? 'opacity-30' : ''}`}
      >
        👍
      </button>
      <button
        type="button"
        onClick={() => void rate(-1)}
        disabled={busy || sent !== 0}
        title="Неточный ответ"
        className={`rounded px-1.5 py-0.5 text-xs transition-opacity ${
          sent === -1 ? 'opacity-100' : 'opacity-50 hover:opacity-90'
        } ${sent === 1 ? 'opacity-30' : ''}`}
      >
        👎
      </button>
      {fresh && <span className="text-[10px] text-slate-400">спасибо, оценка сохранена</span>}
    </div>
  );
}

/** Widget must never show a blank box: any render error becomes a hint. */
export class ChatBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="flex h-full min-h-40 items-center justify-center p-6 text-center text-sm text-slate-500">
          Не удалось запустить чат. Обновите страницу.
        </div>
      );
    }
    return this.props.children;
  }
}
