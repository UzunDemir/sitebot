'use client';

import { useEffect, useState } from 'react';
import { Chat, type ChatBotInfo } from '../../chat-core';

type EmbedError = 'not_found' | 'not_seeded' | 'origin_not_allowed' | 'not_configured' | 'network';

export default function EmbedApp({ botKey }: { botKey: string }) {
  const [bot, setBot] = useState<ChatBotInfo | null>(null);
  const [error, setError] = useState<EmbedError | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/bot?key=${encodeURIComponent(botKey)}`);
        const payload = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && payload && Array.isArray(payload.bots) && payload.bots.length > 0) {
          setBot(payload.bots[0] as ChatBotInfo);
        } else {
          setError((payload?.error as EmbedError) ?? 'network');
        }
      } catch {
        if (!cancelled) setError('network');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [botKey]);

  if (error) {
    const text =
      error === 'origin_not_allowed'
        ? 'Встраивание бота на этот сайт не разрешено владельцем.'
        : error === 'not_found'
          ? 'Бот не найден или отключён.'
          : 'Бот временно недоступен.';
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-500">
        {text}
      </div>
    );
  }

  if (!bot) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-indigo-600" />
      </div>
    );
  }

  return <Chat bot={bot} theme={bot.theme} compact />;
}
