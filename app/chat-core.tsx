'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { WidgetTheme } from '@/lib/widget-theme';
import { readBrowserSessionKey } from '@/lib/session-key';

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
    radius: Math.min(28, Math.max(0, t.radius ?? 16)),
  };
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
  const title = t.title || bot.name;
  const subtitle = t.subtitle || 'Отвечает по базе знаний, с источниками';
  const [input, setInput] = useState('');
  const [sessionKey, setSessionKey] = useState('');
  const [inFrame, setInFrame] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

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
    // Per-bot key (sitebot_session_<pk>): two widgets on one device keep
    // separate dialogs. The legacy shared key is adopted once so existing
    // visitors continue their conversation after this upgrade.
    setSessionKey(readBrowserSessionKey(bot.publicKey));
  }, [bot.publicKey]);

  useEffect(() => {
    // In widget mode (host-page iframe) we can ask the loader to
    // collapse the chat window via postMessage.
    setInFrame(window.parent !== window);
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
        body: { botKey: bot.publicKey, sessionKey },
      }),
    [bot.publicKey, sessionKey],
  );

  const { messages, sendMessage, setMessages, status, error } = useChat({ transport });

  // Dialog memory: restore the stored conversation for this bot + session so
  // a reload (or a return visit) continues the dialog instead of starting
  // over. Best effort: a failed fetch never blocks the chat, and a dialog
  // already on screen is never overwritten.
  useEffect(() => {
    if (!sessionKey) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/chat/history?botKey=${encodeURIComponent(bot.publicKey)}&sessionKey=${encodeURIComponent(sessionKey)}`,
        );
        if (!res.ok) return;
        const payload = (await res.json().catch(() => null)) as { messages?: unknown[] } | null;
        const restored = Array.isArray(payload?.messages) ? (payload.messages as UIMessage[]) : [];
        if (cancelled || restored.length === 0) return;
        setMessages((current) => (current.length > 0 ? current : restored));
      } catch {
        // history is a bonus; ignore failures
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionKey, bot.publicKey, setMessages]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, status]);

  const busy = status === 'submitted' || status === 'streaming';

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
    sendMessage({ text });
    setInput('');
  }

  const bubbleRadius = p.radius;

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
            className="-mr-1 ml-1 flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none opacity-60 transition-opacity hover:opacity-100"
            style={{ color: p.headerText }}
          >
            ▾
          </button>
        )}
      </header>

      <div ref={listRef} className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
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
            {bot.greeting ?? 'Здравствуйте! Чем могу помочь?'}
          </div>
        </div>

        {messages.map((message) => {
          const text = messageText(message.parts);
          const sources = sourcesFromParts(message.parts);
          const feedback = feedbackFromParts(message.parts);

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
                <div
                  className="px-4 py-3 text-sm whitespace-pre-wrap"
                  style={{
                    backgroundColor: p.botBubbleBg,
                    color: p.botBubbleText,
                    borderRadius: bubbleRadius,
                    borderBottomLeftRadius: 6,
                  }}
                >
                  {text || (status === 'streaming' ? '…' : '')}
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

        {status === 'submitted' && (
          <div className="flex justify-start">
            <div
              className="px-4 py-3 text-sm"
              style={{
                backgroundColor: p.botBubbleBg,
                color: p.subtleText,
                borderRadius: bubbleRadius,
                borderBottomLeftRadius: 6,
              }}
            >
              Ищу в базе знаний…
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
        className="flex gap-2 border-t px-4 py-3"
        style={{
          borderColor: p.border,
          backgroundColor: p.headerBg,
          ...(compact ? { paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' } : {}),
        }}
      >
        <input
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
