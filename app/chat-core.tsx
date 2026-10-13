'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WidgetTheme } from '@/lib/widget-theme';

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

type FeedbackInfo = { messageId: number | null };

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

/** Session id with fallbacks: crypto.randomUUID is missing in insecure
 *  contexts (an https iframe inside an http page) and in old WebViews —
 *  a session key needs uniqueness, not cryptographic randomness. */
function makeSessionId(): string {
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
    let key = '';
    try {
      key = window.localStorage.getItem('sitebot_session') ?? '';
      if (!key) {
        key = makeSessionId();
        window.localStorage.setItem('sitebot_session', key);
      }
    } catch {
      // Storage unavailable (private mode, blocked third-party storage in
      // an iframe): keep the session in memory — never crash the widget.
      key = makeSessionId();
    }
    setSessionKey(key);
  }, []);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        body: { botKey: bot.publicKey, sessionKey },
      }),
    [bot.publicKey, sessionKey],
  );

  const { messages, sendMessage, status, error } = useChat({ transport });

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
        style={{ backgroundColor: p.headerBg, borderColor: p.border }}
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
        style={{ borderColor: p.border, backgroundColor: p.headerBg }}
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
  const [sent, setSent] = useState<0 | 1 | -1>(0);
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
      if (res.ok) setSent(rating);
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
      {sent !== 0 && <span className="text-[10px] text-slate-400">спасибо, оценка сохранена</span>}
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
