'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useMemo, useRef, useState } from 'react';

type SourceItem = {
  n: number;
  title: string | null;
  source: string | null;
  similarity: number | null;
};

type BotInfo = {
  publicKey: string;
  name: string;
  greeting: string | null;
};

type LoadError = 'not_seeded' | 'not_configured' | 'network';

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

export default function ChatLoader() {
  const [bots, setBots] = useState<BotInfo[] | null>(null);
  const [selectedKey, setSelectedKey] = useState('');
  const [loadError, setLoadError] = useState<LoadError | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/bot');
        const payload = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && payload && Array.isArray(payload.bots) && payload.bots.length > 0) {
          const list = payload.bots as BotInfo[];
          setBots(list);
          setSelectedKey(list[0].publicKey);
        } else if (res.status === 404) {
          setLoadError('not_seeded');
        } else if (res.status === 500) {
          setLoadError((payload?.error as LoadError) ?? 'not_configured');
        } else {
          setLoadError('network');
        }
      } catch {
        if (!cancelled) setLoadError('network');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) return <SetupCard variant={loadError} />;
  if (!bots || bots.length === 0) return <LoadingCard />;
  const selected = bots.find((b) => b.publicKey === selectedKey) ?? bots[0];

  return (
    <div>
      {bots.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>Бот:</span>
          <select
            value={selected.publicKey}
            onChange={(e) => setSelectedKey(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-indigo-500"
          >
            {bots.map((bot) => (
              <option key={bot.publicKey} value={bot.publicKey}>
                {bot.name}
              </option>
            ))}
          </select>
          <span className="text-slate-400">при переключении начинается новый диалог</span>
        </div>
      )}
      <Chat key={selected.publicKey} bot={selected} />
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="flex h-[85vh] animate-pulse flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="h-10 w-2/3 rounded-lg bg-slate-100" />
      <div className="h-24 w-full rounded-2xl bg-slate-100" />
      <div className="mt-auto h-12 w-full rounded-xl bg-slate-100" />
    </div>
  );
}

function SetupCard({ variant }: { variant: LoadError }) {
  const title =
    variant === 'not_seeded'
      ? 'База знаний ещё не подключена'
      : variant === 'not_configured'
        ? 'Сервер не настроен'
        : 'Сервер недоступен';

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
      <h1 className="text-xl font-semibold text-slate-900">sitebot</h1>
      <p className="mt-2 text-sm text-slate-600">{title}. Выполните шаги:</p>
      <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-slate-700">
        <li>
          Выполните SQL из <code className="rounded bg-slate-100 px-1">sql/0001_init.sql</code> в
          Supabase SQL Editor.
        </li>
        <li>
          Заполните <code className="rounded bg-slate-100 px-1">.env.local</code> по образцу{' '}
          <code className="rounded bg-slate-100 px-1">.env.example</code>.
        </li>
        <li>
          Запустите <code className="rounded bg-slate-100 px-1">npm run seed</code>.
        </li>
        <li>Обновите страницу.</li>
      </ol>
      {variant === 'network' && (
        <p className="mt-3 text-xs text-slate-400">
          Если приложение на Vercel — проверьте переменные окружения в настройках проекта.
        </p>
      )}
    </div>
  );
}

function Chat({ bot }: { bot: BotInfo }) {
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
    () => new DefaultChatTransport({ api: '/api/chat', body: { botKey: bot.publicKey, sessionKey } }),
    [bot.publicKey, sessionKey],
  );

  const { messages, sendMessage, status, error } = useChat({ transport });

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, status]);

  const busy = status === 'submitted' || status === 'streaming';

  function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    sendMessage({ text });
    setInput('');
  }

  return (
    <div className="flex h-[85vh] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-center gap-3 border-b border-slate-200 px-5 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-600 text-lg text-white">
          💬
        </div>
        <div>
          <h1 className="text-sm font-semibold text-slate-900">{bot.name}</h1>
          <p className="text-xs text-slate-500">Отвечает по базе знаний, с источниками</p>
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

          if (message.role === 'user') {
            return (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-indigo-600 px-4 py-3 text-sm whitespace-pre-wrap text-white">
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

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Не удалось получить ответ. Попробуйте ещё раз.
          </div>
        )}
      </div>

      <form onSubmit={submit} className="flex gap-2 border-t border-slate-200 px-4 py-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Спросите про доставку, возврат, оплату…"
          className="flex-1 rounded-xl border border-slate-300 px-4 py-2.5 text-sm outline-none focus:border-indigo-500"
          maxLength={1000}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? '…' : 'Отправить'}
        </button>
      </form>
    </div>
  );
}
