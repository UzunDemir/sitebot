'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useMemo, useRef, useState } from 'react';

export type ChatTheme = { accent?: string };

export type ChatBotInfo = {
  publicKey: string;
  name: string;
  greeting: string | null;
  theme?: ChatTheme;
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

export function Chat({
  bot,
  theme,
  compact = false,
}: {
  bot: ChatBotInfo;
  theme?: ChatTheme;
  compact?: boolean;
}) {
  const accent = theme?.accent || bot.theme?.accent || DEFAULT_ACCENT;
  const [input, setInput] = useState('');
  const [sessionKey, setSessionKey] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let key = window.localStorage.getItem('sitebot_session');
    if (!key) {
      key = crypto.randomUUID();
      window.localStorage.setItem('sitebot_session', key);
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

  return (
    <div
      className={`flex flex-col overflow-hidden bg-white ${
        compact ? 'h-full' : 'h-[85vh] rounded-2xl border border-slate-200 shadow-sm'
      }`}
    >
      <header className="flex items-center gap-3 border-b border-slate-200 px-5 py-4">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-full text-lg text-white"
          style={{ backgroundColor: accent }}
        >
          💬
        </div>
        <div>
          <h1 className="text-sm font-semibold text-slate-900">{bot.name}</h1>
          {!compact && <p className="text-xs text-slate-500">Отвечает по базе знаний, с источниками</p>}
        </div>
        <span
          className={`ml-auto inline-flex h-2.5 w-2.5 rounded-full ${busy ? 'bg-amber-400' : 'bg-emerald-500'}`}
          title={busy ? 'Генерирую ответ' : 'Готов'}
        />
      </header>

      <div ref={listRef} className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
        <div className="flex justify-start">
          <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-slate-100 px-4 py-3 text-sm whitespace-pre-wrap text-slate-800">
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
                  className="max-w-[85%] rounded-2xl rounded-br-md px-4 py-3 text-sm whitespace-pre-wrap text-white"
                  style={{ backgroundColor: accent }}
                >
                  {text}
                </div>
              </div>
            );
          }

          return (
            <div key={message.id} className="flex justify-start">
              <div className="max-w-[85%] space-y-2">
                <div className="rounded-2xl rounded-bl-md bg-slate-100 px-4 py-3 text-sm whitespace-pre-wrap text-slate-800">
                  {text || (status === 'streaming' ? '…' : '')}
                </div>
                {sources.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {sources.map((s) => (
                      <span
                        key={s.n}
                        className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-500"
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
            <div className="rounded-2xl rounded-bl-md bg-slate-100 px-4 py-3 text-sm text-slate-400">
              Ищу в базе знаний…
            </div>
          </div>
        )}

        {errorText && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errorText}
          </div>
        )}
      </div>

      <form onSubmit={submit} className="flex gap-2 border-t border-slate-200 px-4 py-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Спросите что-нибудь…"
          className="flex-1 rounded-xl border border-slate-300 px-4 py-2.5 text-sm outline-none focus:border-indigo-500"
          maxLength={1000}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-xl px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          style={{ backgroundColor: accent }}
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
