'use client';

import { useEffect, useState } from 'react';
import { Chat, type ChatBotInfo } from './chat-core';

type LoadError = 'not_seeded' | 'not_configured' | 'network' | 'origin_not_allowed';

export default function ChatLoader() {
  const [bots, setBots] = useState<ChatBotInfo[] | null>(null);
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
          const list = payload.bots as ChatBotInfo[];
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
        : variant === 'origin_not_allowed'
          ? 'Встраивание не разрешено'
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
