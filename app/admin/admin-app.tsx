'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WidgetColors, WidgetTheme } from '@/lib/widget-theme';
import {
  BOT_SETTINGS_DEFAULTS,
  effectiveAggressiveness,
  type BotChattiness,
  type BotGoal,
  type BotSettings,
} from '@/lib/bot-settings';
import { KNOWLEDGE_PACKS } from '@/lib/knowledge-packs';
import { TACTICS } from '@/lib/tactics';
import VisitorsPanel from './visitors-panel';

const CHANNEL_CARDS: Array<{ name: string; status: string; note: string }> = [
  { name: 'Telegram', status: 'В разработке', note: 'Бот в мессенджере — первый канал для исходящих сообщений (в т.ч. поздравлений).' },
  { name: 'WhatsApp Business', status: 'В планах', note: 'Через Meta Business API (нужна верификация бизнеса).' },
  { name: 'VK', status: 'В планах', note: 'Сообщения сообщества через Callback API.' },
  { name: 'API и приложения', status: 'В планах', note: 'REST + подписанная идентичность клиента для нативных приложений.' },
];

const THEME_COLOR_FIELDS: Array<{ key: keyof WidgetColors; label: string }> = [
  { key: 'headerBg', label: 'Фон шапки' },
  { key: 'headerText', label: 'Текст шапки' },
  { key: 'botBubbleBg', label: 'Пузырь бота: фон' },
  { key: 'botBubbleText', label: 'Пузырь бота: текст' },
  { key: 'userBubbleBg', label: 'Пузырь клиента: фон' },
  { key: 'userBubbleText', label: 'Пузырь клиента: текст' },
  { key: 'pageBg', label: 'Фон чата' },
  { key: 'inputBg', label: 'Поле ввода: фон' },
];

type Bot = {
  id: string;
  name: string;
  public_key: string;
  model_id: string;
  system_prompt: string;
  greeting: string | null;
  temperature: number;
  top_k: number;
  thinking_enabled: boolean;
  is_active: boolean;
  theme: WidgetTheme | null;
  allowed_origins: string[] | null;
  settings: BotSettings | null;
  created_at: string;
};

type ModelInfo = { id: string; label: string; provider: string };

type Doc = {
  id: string;
  title: string;
  source: string | null;
  status: 'pending' | 'processing' | 'ready' | 'error';
  error: string | null;
  chunk_count: number;
  created_at: string;
  updated_at: string;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
async function api(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const res = await fetch(url, init);
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

const ERROR_TEXT: Record<string, string> = {
  unauthorized: 'Сессия истекла — войдите заново.',
  wrong_password: 'Неверный пароль.',
  admin_not_configured: 'ADMIN_SECRET не настроен на сервере.',
  file_too_large: 'Файл больше 4 МБ — разделите его на части.',
  unsupported_type: 'Поддерживаются файлы .txt, .md и .pdf.',
  no_file: 'Выберите файл.',
  pdf_parse_failed: 'Не удалось извлечь текст из PDF.',
  bot_not_found: 'Бот не найден.',
  ingest_failed: 'Не удалось обработать документ.',
  unknown_model: 'Эта модель не поддерживается.',
  bad_name: 'Нужно название.',
};

function errorText(data: any, fallback: string): string {
  if (data && typeof data.message === 'string' && data.message) return data.message;
  const code = data && typeof data.error === 'string' ? data.error : '';
  return ERROR_TEXT[code] ?? fallback;
}

export default function AdminApp() {
  const [phase, setPhase] = useState<'checking' | 'login' | 'ready'>('checking');
  const [notConfigured, setNotConfigured] = useState(false);

  const [bots, setBots] = useState<Bot[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedBotId, setSelectedBotId] = useState('');
  const [docs, setDocs] = useState<Doc[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  // Тема админки: светлая/тёмная (класс на <html> + localStorage).
  useEffect(() => {
    try {
      if (window.localStorage.getItem('sitebot-admin-dark') === '1') setTheme('dark');
    } catch {
      // storage unavailable — остаёмся на светлой
    }
  }, []);

  useEffect(() => {
    try {
      document.documentElement.classList.toggle('dark-admin', theme === 'dark');
      window.localStorage.setItem('sitebot-admin-dark', theme === 'dark' ? '1' : '0');
    } catch {
      // ignore
    }
  }, [theme]);

  const toggleTheme = () => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  const [tab, setTab] = useState<'visitors' | 'bot' | 'knowledge' | 'stats'>('visitors');

  const loadBots = useCallback(async (): Promise<void> => {
    const res = await api('/api/admin/bots');
    if (res.status === 500 && res.data?.error === 'admin_not_configured') {
      setNotConfigured(true);
      setPhase('login');
      return;
    }
    if (res.status === 401 || !res.ok || !res.data) {
      setPhase('login');
      return;
    }
    const list: Bot[] = Array.isArray(res.data.bots) ? res.data.bots : [];
    setBots(list);
    setModels(Array.isArray(res.data.models) ? res.data.models : []);
    setSelectedBotId((prev) => prev || list[0]?.id || '');
    setPhase('ready');
  }, []);

  useEffect(() => {
    void loadBots();
  }, [loadBots]);

  const loadDocs = useCallback(async (botId: string): Promise<void> => {
    if (!botId) {
      setDocs([]);
      return;
    }
    const res = await api(`/api/admin/documents?botId=${encodeURIComponent(botId)}`);
    if (res.ok && res.data && Array.isArray(res.data.documents)) {
      setDocs(res.data.documents);
    }
  }, []);

  useEffect(() => {
    if (phase === 'ready' && selectedBotId) void loadDocs(selectedBotId);
  }, [phase, selectedBotId, loadDocs]);

  const selectedBot = useMemo(
    () => bots.find((bot) => bot.id === selectedBotId) ?? null,
    [bots, selectedBotId],
  );

  if (phase === 'checking') {
    return (
      <div
        className={`admin-shell flex h-full items-center justify-center p-6 ${theme === 'dark' ? 'dark-admin' : ''}`}
      >
        <div className="w-[480px] animate-pulse border border-slate-200 bg-white p-8">
          <div className="h-6 w-40 bg-slate-100" />
          <div className="mt-4 h-24 w-full bg-slate-100" />
        </div>
      </div>
    );
  }

  if (phase === 'login') {
    return (
      <div
        className={`admin-shell flex h-full items-center justify-center p-6 ${theme === 'dark' ? 'dark-admin' : ''}`}
      >
        <LoginCard notConfigured={notConfigured} onLoggedIn={loadBots} />
      </div>
    );
  }

  return (
    <div className={`admin-shell flex h-full min-h-0 flex-col ${theme === 'dark' ? 'dark-admin' : ''}`}>
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex h-8 w-8 items-center justify-center bg-indigo-600 text-base text-white">⚙️</div>
        <div>
          <h1 className="text-sm font-semibold text-slate-900">sitebot — админка</h1>
          <p className="hidden text-[11px] text-slate-500 sm:block">
            {selectedBot ? selectedBot.name : 'База знаний, модель и промпт — без кода и деплоя'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <a
            href="/"
            className="border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            ← к боту
          </a>
          <button
            type="button"
            onClick={toggleTheme}
            className="border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            {theme === 'dark' ? '☀️ Светлая тема' : '🌙 Тёмная тема'}
          </button>
          <button
            type="button"
            onClick={async () => {
              await api('/api/admin/logout', { method: 'POST' });
              setBots([]);
              setDocs([]);
              setSelectedBotId('');
              setPhase('login');
            }}
            className="border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            Выйти
          </button>
        </div>
      </header>

      <BotBar
        bots={bots}
        selectedBotId={selectedBotId}
        onSelect={setSelectedBotId}
        onCreated={(bot) => {
          setBots((prev) => [...prev, bot]);
          setSelectedBotId(bot.id);
        }}
      />

      <nav className="flex items-center gap-1 border-b border-slate-200 bg-white px-3">
        {(
          [
            ['visitors', 'Посетители'],
            ['bot', 'Бот и логика'],
            ['knowledge', 'База знаний'],
            ['stats', 'Статистика'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`border-b-2 px-3 py-2 text-xs ${
              tab === id
                ? 'border-indigo-600 font-medium text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-hidden p-3">
        {!selectedBot && (
          <p className="text-xs text-slate-400">Создайте бота, чтобы увидеть данные.</p>
        )}

        {selectedBot && tab === 'visitors' && (
          <VisitorsPanel key={`visitors-${selectedBot.id}`} botId={selectedBot.id} />
        )}

        {selectedBot && tab === 'bot' && (
          <div className="h-full min-h-0 overflow-auto pr-1">
            <BotSettings
              key={selectedBot.id}
              bot={selectedBot}
              models={models}
              onSaved={(bot) => setBots((prev) => prev.map((b) => (b.id === bot.id ? bot : b)))}
            />
          </div>
        )}

        {selectedBot && tab === 'knowledge' && (
          <div className="h-full min-h-0 overflow-auto pr-1">
            <DocumentsPanel
              botId={selectedBot.id}
              docs={docs}
              onChanged={() => void loadDocs(selectedBot.id)}
            />
          </div>
        )}

        {selectedBot && tab === 'stats' && (
          <div className="h-full min-h-0 overflow-auto pr-1">
            <StatsPanel key={`stats-${selectedBot.id}`} botId={selectedBot.id} />
          </div>
        )}
      </div>
    </div>
  );
}

function LoginCard({
  notConfigured,
  onLoggedIn,
}: {
  notConfigured: boolean;
  onLoggedIn: () => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const res = await api('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    setBusy(false);
    if (res.ok) {
      await onLoggedIn();
      return;
    }
    setError(errorText(res.data, 'Не удалось войти.'));
  }

  return (
    <div className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
      <h1 className="text-xl font-semibold text-slate-900">Админка sitebot</h1>
      <p className="mt-2 text-sm text-slate-600">Вход по паролю из переменной ADMIN_SECRET.</p>

      {notConfigured && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          Сервер не настроен: добавьте <code>ADMIN_SECRET</code> в <code>.env.local</code> (локально) и
          в переменные проекта на Vercel, затем перезапустите сервер / сделайте Redeploy.
        </div>
      )}

      <form onSubmit={submit} className="mt-4 space-y-3">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Пароль администратора"
          className="w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm outline-none focus:border-indigo-500"
        />
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Проверяю…' : 'Войти'}
        </button>
      </form>

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function BotBar({
  bots,
  selectedBotId,
  onSelect,
  onCreated,
}: {
  bots: Bot[];
  selectedBotId: string;
  onSelect: (id: string) => void;
  onCreated: (bot: Bot) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    const res = await api('/api/admin/bots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    setBusy(false);
    if (res.ok && res.data?.bot) {
      onCreated(res.data.bot as Bot);
      setNewName('');
      setCreating(false);
    } else {
      setError(errorText(res.data, 'Не удалось создать бота.'));
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white px-5 py-3 shadow-sm">
      <span className="text-xs font-medium text-slate-500">Бот:</span>
      <select
        value={selectedBotId}
        onChange={(e) => onSelect(e.target.value)}
        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
      >
        {bots.map((bot) => (
          <option key={bot.id} value={bot.id}>
            {bot.name}
            {bot.is_active ? '' : ' — выключен'}
          </option>
        ))}
      </select>

      {!creating ? (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50"
        >
          + Новый бот
        </button>
      ) : (
        <span className="flex items-center gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Название бота"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
          <button
            type="button"
            disabled={busy || !newName.trim()}
            onClick={create}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {busy ? '…' : 'Создать'}
          </button>
          <button
            type="button"
            onClick={() => {
              setCreating(false);
              setError(null);
            }}
            className="text-xs text-slate-400 hover:text-slate-600"
          >
            отмена
          </button>
        </span>
      )}

      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

function BotSettings({
  bot,
  models,
  onSaved,
}: {
  bot: Bot;
  models: ModelInfo[];
  onSaved: (bot: Bot) => void;
}) {
  const [form, setForm] = useState({
    name: bot.name,
    greeting: bot.greeting ?? '',
    system_prompt: bot.system_prompt,
    model_id: bot.model_id,
    top_k: bot.top_k,
    thinking_enabled: bot.thinking_enabled,
    is_active: bot.is_active,
    allowed_origins: (bot.allowed_origins ?? []).join('\n'),
  });
  const [theme, setTheme] = useState<WidgetTheme>(bot.theme ?? {});
  const [settings, setSettings] = useState<BotSettings>(bot.settings ?? {});
  const [tab, setTab] = useState<'ui' | 'logic' | 'channels'>('ui');
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const embedSnippet = `<script src="${typeof window !== 'undefined' ? window.location.origin : ''}/loader.js?v=14" data-bot="${bot.public_key}" async></script>`;

  function setThemeField<K extends keyof WidgetTheme>(key: K, value: WidgetTheme[K]) {
    setTheme((prev) => ({ ...prev, [key]: value }));
  }

  function setThemeColor(key: keyof WidgetColors, value: string) {
    setTheme((prev) => ({ ...prev, colors: { ...(prev.colors ?? {}), [key]: value } }));
  }

  function setSetting<K extends keyof BotSettings>(key: K, value: BotSettings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  function setProactive(patch: NonNullable<BotSettings['proactive']>) {
    setSettings((prev) => ({ ...prev, proactive: { ...(prev.proactive ?? {}), ...patch } }));
  }

  async function readImageFile(file: File): Promise<string | null> {
    if (!file.type.startsWith('image/')) {
      setUploadError('Нужен файл-картинка (png, jpg, svg).');
      return null;
    }
    if (file.size > 100_000) {
      setUploadError('Картинка больше 100 КБ — сожмите её или укажите ссылку.');
      return null;
    }
    setUploadError(null);
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function save(e: { preventDefault(): void }) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const res = await api(`/api/admin/bots/${bot.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: form.name,
        greeting: form.greeting,
        system_prompt: form.system_prompt,
        model_id: form.model_id,
        top_k: form.top_k,
        thinking_enabled: form.thinking_enabled,
        is_active: form.is_active,
        theme,
        settings,
        allowed_origins: form.allowed_origins,
      }),
    });
    setBusy(false);
    if (res.ok && res.data?.bot) {
      onSaved(res.data.bot as Bot);
      setMessage({
        kind: 'ok',
        text: 'Сохранено. Если меняли внешний вид — обновите страницу сайта с виджетом (Ctrl+F5).',
      });
    } else {
      setMessage({ kind: 'err', text: errorText(res.data, 'Не удалось сохранить.') });
    }
  }

  return (
    <form onSubmit={save} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Настройки бота</h2>
        <code
          className="rounded bg-slate-100 px-2 py-1 text-[11px] text-slate-500"
          title="Публичный ключ бота — понадобится виджету"
        >
          {bot.public_key}
        </code>
      </div>

      <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1">
        {(
          [
            ['ui', 'Интерфейс'],
            ['logic', 'Логика'],
            ['channels', 'Каналы'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-lg px-4 py-1.5 text-xs font-medium transition-colors ${
              tab === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'logic' && (
        <>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-slate-500">
          Название
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
          />
        </label>

        <label className="space-y-1 text-xs text-slate-500">
          Модель
          <select
            value={form.model_id}
            onChange={(e) => setForm({ ...form, model_id: e.target.value })}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-xs text-slate-500 sm:col-span-2">
          Приветствие (первое сообщение в чате)
          <input
            value={form.greeting}
            onChange={(e) => setForm({ ...form, greeting: e.target.value })}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
          />
        </label>

        <div className="flex flex-wrap items-end gap-5 sm:col-span-2">
          <label className="space-y-1 text-xs text-slate-500">
            Источников в контексте (top_k)
            <input
              type="number"
              min={1}
              max={10}
              value={form.top_k}
              onChange={(e) => setForm({ ...form, top_k: Number(e.target.value) || 6 })}
              className="w-24 rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
            />
          </label>
          <label className="flex items-center gap-2 pb-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={form.thinking_enabled}
              onChange={(e) => setForm({ ...form, thinking_enabled: e.target.checked })}
              className="h-4 w-4"
            />
            Reasoning-режим (медленнее, глубже)
          </label>
          <label className="flex items-center gap-2 pb-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
              className="h-4 w-4"
            />
            Бот активен
          </label>
        </div>
      </div>

      <div className="space-y-4 rounded-xl border border-slate-100 bg-slate-50/60 p-4">
        <p className="text-xs font-semibold text-slate-600">Поведение</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-slate-500">
            Размер ответа, токенов (120–2400)
            <input
              type="number"
              min={120}
              max={2400}
              value={settings.maxOutputTokens ?? BOT_SETTINGS_DEFAULTS.maxOutputTokens}
              onChange={(e) => setSetting('maxOutputTokens', Number(e.target.value) || BOT_SETTINGS_DEFAULTS.maxOutputTokens)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
            />
            <span className="text-[10px] text-slate-400">
              ≈ {Math.round(((settings.maxOutputTokens ?? BOT_SETTINGS_DEFAULTS.maxOutputTokens) * 2) / 100) * 100} знаков
            </span>
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Память диалога, сообщений (0 = вся история)
            <input
              type="number"
              min={0}
              max={50}
              value={settings.historyDepth ?? BOT_SETTINGS_DEFAULTS.historyDepth}
              onChange={(e) => setSetting('historyDepth', Math.max(0, Number(e.target.value) || 0))}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
            />
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Общительность
            <select
              value={settings.chattiness ?? BOT_SETTINGS_DEFAULTS.chattiness}
              onChange={(e) => setSetting('chattiness', e.target.value as BotChattiness)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
            >
              <option value="strict">Строго по вопросу</option>
              <option value="friendly">Дружелюбно</option>
              <option value="proactive">Проактивно</option>
              <option value="initiator">Ведёт диалог сам</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Агрессивность продаж: {effectiveAggressiveness(settings)}/100
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={effectiveAggressiveness(settings)}
              onChange={(e) => setSetting('aggressiveness', Number(e.target.value))}
              className="w-full"
            />
            <span className="text-[10px] text-slate-400">
              0 — без давления · 50 — мягко предлагать · 80+ — активно вести к цели
              {settings.aggressiveness == null
                ? ` (сейчас действует старая настройка «${settings.salesPressure === 2 ? 'активно продавать' : settings.salesPressure === 1 ? 'умеренно' : 'без давления'}» — троньте ползунок, чтобы закрепить)`
                : ''}
            </span>
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Тон общения: {settings.tone ?? BOT_SETTINGS_DEFAULTS.tone}/100
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={settings.tone ?? BOT_SETTINGS_DEFAULTS.tone}
              onChange={(e) => setSetting('tone', Number(e.target.value))}
              className="w-full"
            />
            <span className="text-[10px] text-slate-400">0 — дружеский · 100 — официальный</span>
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Юмор: {settings.humor ?? BOT_SETTINGS_DEFAULTS.humor}/100
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={settings.humor ?? BOT_SETTINGS_DEFAULTS.humor}
              onChange={(e) => setSetting('humor', Number(e.target.value))}
              className="w-full"
            />
            <span className="text-[10px] text-slate-400">0 — серьёзно · 100 — тепло и с шутками</span>
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Хитрость: {settings.cunning ?? BOT_SETTINGS_DEFAULTS.cunning}/100
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={settings.cunning ?? BOT_SETTINGS_DEFAULTS.cunning}
              onChange={(e) => setSetting('cunning', Number(e.target.value))}
              className="w-full"
            />
            <span className="text-[10px] text-slate-400">
              0 — прямо · 100 — изобретательно вести к цели (без обмана)
            </span>
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Остроумие: {settings.wit ?? BOT_SETTINGS_DEFAULTS.wit}/100
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={settings.wit ?? BOT_SETTINGS_DEFAULTS.wit}
              onChange={(e) => setSetting('wit', Number(e.target.value))}
              className="w-full"
            />
            <span className="text-[10px] text-slate-400">0 — просто · 100 — метко и неожиданно</span>
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Цель диалога
            <select
              value={settings.goal ?? 'none'}
              onChange={(e) => setSetting('goal', e.target.value as BotGoal)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
            >
              <option value="none">Без цели</option>
              <option value="phone">Получить телефон</option>
              <option value="messenger">Перевести в мессенджер</option>
              <option value="call">Договориться о звонке</option>
              <option value="booking">Записать на визит/примерку</option>
              <option value="demo">Договориться о демо</option>
              <option value="purchase">Довести до покупки</option>
              <option value="order">Оформить заказ</option>
              <option value="quote">Подготовить расчёт</option>
              <option value="review">Получить отзыв</option>
              <option value="birthday">Узнать день рождения</option>
              <option value="custom">Своя цель…</option>
            </select>
          </label>
          {settings.goal === 'custom' && (
            <label className="space-y-1 text-xs text-slate-500">
              Своя цель (до 200 символов)
              <input
                value={settings.goalText ?? ''}
                maxLength={200}
                onChange={(e) => setSetting('goalText', e.target.value)}
                placeholder="Например: записать на примерку"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
              />
            </label>
          )}
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={settings.showSources !== false}
            onChange={(e) => setSetting('showSources', e.target.checked)}
            className="h-4 w-4"
          />
          Показывать источники в ответах (рекомендуется: проверяемость и доверие)
        </label>
        {settings.showSources === false && (
          <p className="text-[11px] text-amber-700">
            Источники скрыты: ответы станут «гладкими», но их нельзя будет проверить по базе, и
            метрика цитирования в статистике перестанет расти.
          </p>
        )}

        <div className="space-y-2 border-t border-slate-200 pt-3">
          <p className="text-xs font-semibold text-slate-600">Пресеты характера</p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                [
                  'Поддержка',
                  { aggressiveness: 10, empathy: 80, tone: 10, humor: 35, cunning: 20, wit: 30 },
                ],
                [
                  'Продажа-консультация',
                  { aggressiveness: 45, empathy: 55, tone: 35, humor: 35, cunning: 55, wit: 45 },
                ],
                [
                  'Активный клоузер',
                  { aggressiveness: 90, empathy: 40, tone: 20, humor: 40, cunning: 85, wit: 85 },
                ],
              ] as const
            ).map(([label, preset]) => (
              <button
                key={label}
                type="button"
                onClick={() => {
                  const apply = setSetting as unknown as (key: string, value: number) => void;
                  for (const [key, value] of Object.entries(preset)) apply(key, value);
                }}
                className="border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-slate-400">
            Пресет задаёт все шкалы разом — дальше можно подстроить вручную.
          </p>
          {effectiveAggressiveness(settings) >= 80 &&
            (settings.empathy ?? BOT_SETTINGS_DEFAULTS.empathy) >= 80 && (
              <p className="text-[10px] text-amber-700">
                Конфликт шкал: агрессивность и эмпатия обе высокие — бот давит и сочувствует
                одновременно. Обычно выбирают одно: «Активный клоузер» или «Поддержка».
              </p>
            )}
        </div>

        <div className="space-y-3 border-t border-slate-200 pt-3">
          <p className="text-xs font-semibold text-slate-600">Знания и персона</p>
          <label className="space-y-1 text-xs text-slate-500">
            Эмпатия: {settings.empathy ?? BOT_SETTINGS_DEFAULTS.empathy}/100
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={settings.empathy ?? BOT_SETTINGS_DEFAULTS.empathy}
              onChange={(e) => setSetting('empathy', Number(e.target.value))}
              className="w-full"
            />
            <span className="text-[10px] text-slate-400">
              0 — деловой тон · 100 — сначала признать чувства и ситуацию клиента
            </span>
          </label>
          <div>
            <p className="text-xs text-slate-500">
              Профессиональные наборы — приёмы и стиль (факты бот берёт только из базы знаний и диалога)
            </p>
            <div className="mt-1 grid gap-1.5 sm:grid-cols-2">
              {KNOWLEDGE_PACKS.map((pack) => (
                <label key={pack.id} className="flex items-start gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={(settings.packs ?? []).includes(pack.id)}
                    onChange={(e) => {
                      const current = new Set(settings.packs ?? []);
                      if (e.target.checked) current.add(pack.id);
                      else current.delete(pack.id);
                      setSetting('packs', Array.from(current));
                    }}
                    className="mt-0.5 h-4 w-4"
                  />
                  <span>
                    {pack.title}
                    <span className="block text-[10px] text-slate-400">{pack.about}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <label className="block space-y-1 text-xs text-slate-500">
            Свои знания и указания (до 2000 символов)
            <textarea
              rows={4}
              value={settings.customKnowledge ?? ''}
              maxLength={2000}
              onChange={(e) => setSetting('customKnowledge', e.target.value)}
              placeholder="Например: магазин работает с 2010 года; любимый приём — сравнение двух вариантов; всегда говорить «вы»…"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
            />
          </label>
        </div>

        <div className="space-y-3 border-t border-slate-200 pt-3">
          <p className="text-xs font-semibold text-slate-600">Дожим молчащих посетителей</p>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={settings.proactive?.enabled !== false}
              onChange={(e) => setProactive({ enabled: e.target.checked })}
              className="h-4 w-4"
            />
            Писать первым, если посетитель замолчал (в рамках лимита касаний)
          </label>
          {settings.proactive?.enabled !== false && (
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1 text-xs text-slate-500">
                Касаний подряд (0–5)
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={
                    settings.proactive?.nudges?.attempts ??
                    BOT_SETTINGS_DEFAULTS.proactive.nudges.attempts
                  }
                  onChange={(e) =>
                    setProactive({
                      nudges: {
                        ...(settings.proactive?.nudges ?? {}),
                        attempts: Number(e.target.value) || 0,
                      },
                    })
                  }
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
                />
              </label>
              <label className="space-y-1 text-xs text-slate-500">
                Пауза перед первым, сек (15–600)
                <input
                  type="number"
                  min={15}
                  max={600}
                  value={
                    settings.proactive?.nudges?.firstDelaySec ??
                    BOT_SETTINGS_DEFAULTS.proactive.nudges.firstDelaySec
                  }
                  onChange={(e) =>
                    setProactive({
                      nudges: {
                        ...(settings.proactive?.nudges ?? {}),
                        firstDelaySec: Number(e.target.value) || 45,
                      },
                    })
                  }
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
                />
              </label>
              <label className="space-y-1 text-xs text-slate-500">
                Интервал между касаниями, сек (60–86400)
                <input
                  type="number"
                  min={60}
                  max={86400}
                  value={
                    settings.proactive?.nudges?.intervalSec ??
                    BOT_SETTINGS_DEFAULTS.proactive.nudges.intervalSec
                  }
                  onChange={(e) =>
                    setProactive({
                      nudges: {
                        ...(settings.proactive?.nudges ?? {}),
                        intervalSec: Number(e.target.value) || 300,
                      },
                    })
                  }
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
                />
              </label>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={settings.proactive?.quietHours?.enabled === true}
                onChange={(e) =>
                  setProactive({
                    quietHours: { ...(settings.proactive?.quietHours ?? {}), enabled: e.target.checked },
                  })
                }
                className="h-4 w-4"
              />
              Тихие часы (не писать в это время)
            </label>
            {settings.proactive?.quietHours?.enabled === true && (
              <>
                <label className="space-y-1 text-xs text-slate-500">
                  С
                  <input
                    type="time"
                    value={
                      settings.proactive?.quietHours?.from ??
                      BOT_SETTINGS_DEFAULTS.proactive.quietHours.from
                    }
                    onChange={(e) =>
                      setProactive({
                        quietHours: { ...(settings.proactive?.quietHours ?? {}), enabled: true, from: e.target.value },
                      })
                    }
                    className="rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
                  />
                </label>
                <label className="space-y-1 text-xs text-slate-500">
                  До
                  <input
                    type="time"
                    value={
                      settings.proactive?.quietHours?.to ??
                      BOT_SETTINGS_DEFAULTS.proactive.quietHours.to
                    }
                    onChange={(e) =>
                      setProactive({
                        quietHours: { ...(settings.proactive?.quietHours ?? {}), enabled: true, to: e.target.value },
                      })
                    }
                    className="rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
                  />
                </label>
                <span className="text-[10px] text-slate-400">по местному времени посетителя</span>
              </>
            )}
          </div>
        </div>
      </div>
        </>
      )}

      {tab === 'ui' && (
        <>
      <div className="space-y-4 rounded-xl border border-slate-100 bg-slate-50/60 p-4">
        <p className="text-xs font-semibold text-slate-600">Виджет и внешний вид</p>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-slate-500">
            Позиция кнопки на сайте
            <select
              value={theme.position ?? 'right'}
              onChange={(e) => setThemeField('position', e.target.value === 'left' ? 'left' : 'right')}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
            >
              <option value="right">Справа</option>
              <option value="left">Слева</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Размер кнопки, px (48–80)
            <input
              type="number"
              min={48}
              max={80}
              value={theme.launcherSize ?? 56}
              onChange={(e) => setThemeField('launcherSize', Number(e.target.value) || 56)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
            />
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Подпись рядом с кнопкой (необязательно)
            <input
              value={theme.launcherLabel ?? ''}
              onChange={(e) => setThemeField('launcherLabel', e.target.value)}
              placeholder="Например: Чат с поддержкой"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
            />
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Цвет кнопки-пузыря (пусто = акцент)
            <span className="flex items-center gap-2">
              <input
                type="color"
                value={theme.bubbleColor || '#4f46e5'}
                onChange={(e) => setThemeField('bubbleColor', e.target.value)}
                className="h-9 w-14 cursor-pointer rounded-lg border border-slate-300"
              />
              {theme.bubbleColor ? (
                <button
                  type="button"
                  onClick={() => setThemeField('bubbleColor', undefined)}
                  className="text-[11px] text-slate-400 hover:text-slate-600"
                >
                  сбросить
                </button>
              ) : null}
            </span>
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Акцент чата (пузыри клиента, кнопки в окне)
            <span className="flex items-center gap-2">
              <input
                type="color"
                value={theme.accent || '#4f46e5'}
                onChange={(e) => setThemeField('accent', e.target.value)}
                className="h-9 w-14 cursor-pointer rounded-lg border border-slate-300"
              />
              {theme.accent ? (
                <button
                  type="button"
                  onClick={() => setThemeField('accent', undefined)}
                  className="text-[11px] text-slate-400 hover:text-slate-600"
                >
                  сбросить
                </button>
              ) : null}
            </span>
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Иконка кнопки (emoji, ссылка или файл)
            <span className="flex items-center gap-2">
              <input value={theme.bubbleIcon ?? ''} onChange={(e) => setThemeField('bubbleIcon', e.target.value)} placeholder="🛎 или https://…/icon.png" className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500" />
              <input
                type="file"
                accept="image/*"
                onChange={async (e) => {
                  const input = e.currentTarget;
                  const file = input.files?.[0];
                  if (file) {
                    const dataUrl = await readImageFile(file);
                    if (dataUrl) setThemeField('bubbleIcon', dataUrl);
                  }
                  input.value = '';
                }}
                className="w-28 text-[10px] text-slate-500"
              />
            </span>
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Аватар в шапке чата (ссылка или файл)
            <span className="flex items-center gap-2">
              <input value={theme.avatarUrl ?? ''} onChange={(e) => setThemeField('avatarUrl', e.target.value)} placeholder="https://…/logo.png" className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500" />
              <input
                type="file"
                accept="image/*"
                onChange={async (e) => {
                  const input = e.currentTarget;
                  const file = input.files?.[0];
                  if (file) {
                    const dataUrl = await readImageFile(file);
                    if (dataUrl) setThemeField('avatarUrl', dataUrl);
                  }
                  input.value = '';
                }}
                className="w-28 text-[10px] text-slate-500"
              />
            </span>
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Заголовок виджета (пусто = название бота)
            <input value={theme.title ?? ''} onChange={(e) => setThemeField('title', e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500" />
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Подзаголовок в шапке чата
            <input value={theme.subtitle ?? ''} onChange={(e) => setThemeField('subtitle', e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500" />
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="space-y-1 text-xs text-slate-500">
            Отступ от края, px (0–300)
            <input
              type="number"
              min={0}
              max={300}
              value={theme.offsetX ?? 20}
              onChange={(e) => setThemeField('offsetX', Number(e.target.value) || 0)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
            />
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Отступ снизу, px (0–300)
            <input
              type="number"
              min={0}
              max={300}
              value={theme.offsetY ?? 20}
              onChange={(e) => setThemeField('offsetY', Number(e.target.value) || 0)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
            />
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Тень
            <select
              value={theme.shadow ?? 'medium'}
              onChange={(e) => setThemeField('shadow', e.target.value as 'none' | 'soft' | 'medium' | 'strong')}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
            >
              <option value="medium">Обычная</option>
              <option value="soft">Мягкая</option>
              <option value="strong">Глубокая</option>
              <option value="none">Без тени</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Анимация появления
            <select
              value={theme.animationIn ?? 'slide'}
              onChange={(e) => setThemeField('animationIn', e.target.value as 'none' | 'fade' | 'slide' | 'pop')}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900"
            >
              <option value="slide">Выезд снизу</option>
              <option value="fade">Плавное проявление</option>
              <option value="pop">Масштабирование</option>
              <option value="none">Без анимации</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-slate-500 sm:col-span-2">
            Прозрачность кнопки: {Math.round((theme.opacity ?? 1) * 100)}%
            <input
              type="range"
              min={40}
              max={100}
              step={5}
              value={Math.round((theme.opacity ?? 1) * 100)}
              onChange={(e) => setThemeField('opacity', Number(e.target.value) / 100)}
              className="w-full"
            />
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="space-y-1 text-xs text-slate-500">
            Ширина окна, px (320–560)
            <input
              type="number"
              min={320}
              max={560}
              value={theme.windowWidth ?? 380}
              onChange={(e) => setThemeField('windowWidth', Number(e.target.value) || 380)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
            />
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Высота окна, px (400–820)
            <input
              type="number"
              min={400}
              max={820}
              value={theme.windowHeight ?? 600}
              onChange={(e) => setThemeField('windowHeight', Number(e.target.value) || 600)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
            />
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Закругление, px (0–28)
            <input
              type="number"
              min={0}
              max={28}
              value={theme.radius ?? 16}
              onChange={(e) => setThemeField('radius', Number(e.target.value) || 0)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
            />
          </label>
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={theme.dark === true}
            onChange={(e) => setThemeField('dark', e.target.checked)}
            className="h-4 w-4"
          />
          Тёмная тема чата
        </label>

        <details className="rounded-xl border border-slate-200 bg-white p-3">
          <summary className="cursor-pointer text-xs font-medium text-slate-500">
            Тонкая настройка цветов (перекрывает тему и тёмный режим)
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {THEME_COLOR_FIELDS.map((field) => (
              <label key={field.key} className="flex items-center justify-between gap-2 text-xs text-slate-500">
                {field.label}
                <span className="flex items-center gap-2">
                  <input
                    type="color"
                    value={theme.colors?.[field.key] ?? '#ffffff'}
                    onChange={(e) => setThemeColor(field.key, e.target.value)}
                    className="h-8 w-12 cursor-pointer rounded border border-slate-300"
                  />
                  {theme.colors?.[field.key] ? (
                    <button
                      type="button"
                      onClick={() => setThemeColor(field.key, '')}
                      className="text-[10px] text-slate-400 hover:text-slate-600"
                    >
                      сброс
                    </button>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        </details>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-slate-500">
            Шрифт (CSS font-family)
            <input value={theme.fontFamily ?? ''} onChange={(e) => setThemeField('fontFamily', e.target.value)} placeholder="Inter, system-ui, sans-serif" className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500" />
          </label>
          <label className="space-y-1 text-xs text-slate-500">
            Веб-шрифт: ссылка на CSS (Google Fonts и т.п.)
            <input value={theme.fontUrl ?? ''} onChange={(e) => setThemeField('fontUrl', e.target.value)} placeholder="https://fonts.googleapis.com/css2?family=Inter&display=swap" className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500" />
          </label>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={theme.proactive?.enabled === true}
              onChange={(e) => setTheme({ ...theme, proactive: { ...(theme.proactive ?? {}), enabled: e.target.checked } })}
              className="h-4 w-4"
            />
            Проактивное сообщение возле кнопки (привлекает посетителя)
          </label>
          {theme.proactive?.enabled === true && (
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="space-y-1 text-xs text-slate-500">
                Задержка, сек (3–60)
                <input
                  type="number"
                  min={3}
                  max={60}
                  value={theme.proactive?.delaySeconds ?? 8}
                  onChange={(e) => setTheme({ ...theme, proactive: { ...(theme.proactive ?? {}), enabled: true, delaySeconds: Number(e.target.value) || 8 } })}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
                />
              </label>
              <label className="space-y-1 text-xs text-slate-500 sm:col-span-2">
                Текст (до 160 символов)
                <input
                  value={theme.proactive?.text ?? ''}
                  maxLength={160}
                  onChange={(e) => setTheme({ ...theme, proactive: { ...(theme.proactive ?? {}), enabled: true, text: e.target.value } })}
                  placeholder="Здравствуйте! Подскажу, как оформить заказ?"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
                />
              </label>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          <a
            href={`/embed/${bot.public_key}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-600 hover:bg-slate-50"
          >
            Открыть виджет и проверить оформление
          </a>
          {uploadError && <span className="text-red-600">{uploadError}</span>}
        </div>
      </div>
        </>
      )}

      {tab === 'logic' && (
        <>
      <label className="block space-y-1 text-xs text-slate-500">
        Системный промпт
        <textarea
          rows={5}
          value={form.system_prompt}
          onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
          className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
        />
      </label>
        </>
      )}

      {tab === 'channels' && (
        <>
          <div className="space-y-4 rounded-xl border border-slate-100 bg-slate-50/60 p-4">
            <p className="text-xs font-semibold text-slate-600">Сайт (виджет) — активен</p>
            <div className="rounded-xl bg-slate-900 px-4 py-3">
              <code className="block overflow-x-auto text-[11px] leading-relaxed whitespace-pre text-slate-100">
                {embedSnippet}
              </code>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(embedSnippet).then(() => {
                    setSnippetCopied(true);
                    window.setTimeout(() => setSnippetCopied(false), 2000);
                  });
                }}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
              >
                Скопировать код
              </button>
              {snippetCopied && <span className="text-xs text-emerald-600">скопировано</span>}
            </div>
            <label className="block space-y-1 text-xs text-slate-500">
              Сайты для встраивания (origin; пусто — разрешено везде)
              <textarea
                rows={3}
                value={form.allowed_origins}
                onChange={(e) => setForm({ ...form, allowed_origins: e.target.value })}
                placeholder={'https://my-site.ru\nhttps://shop.example.com'}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
              />
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {CHANNEL_CARDS.map((channel) => (
              <div key={channel.name} className="rounded-xl border border-slate-100 bg-white p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-slate-800">{channel.name}</p>
                  <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] text-slate-400">
                    {channel.status}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">{channel.note}</p>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Сохраняю…' : 'Сохранить'}
        </button>
        {message && (
          <span className={`text-xs ${message.kind === 'ok' ? 'text-emerald-600' : 'text-red-600'}`}>
            {message.text}
          </span>
        )}
      </div>
    </form>
  );
}

function DocumentsPanel({
  botId,
  docs,
  onChanged,
}: {
  botId: string;
  docs: Doc[];
  onChanged: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function upload(e: { preventDefault(): void }) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setMessage({ kind: 'err', text: 'Выберите файл (.txt, .md или .pdf).' });
      return;
    }
    if (busy) return;
    setBusy(true);
    setMessage(null);

    const form = new FormData();
    form.append('botId', botId);
    if (title.trim()) form.append('title', title.trim());
    form.append('file', file);

    const res = await api('/api/admin/documents', { method: 'POST', body: form });
    const label = title.trim() || file.name;
    if (res.ok && res.data) {
      setTitle('');
      if (fileRef.current) fileRef.current.value = '';
      if (res.data.status === 'partial') {
        setMessage({
          kind: 'ok',
          text: `«${label}» — большой документ, индексирую частями (${res.data.chunks}/${res.data.total})…`,
        });
        onChanged();
        await continueIngest(res.data.documentId, label);
      } else if (res.data.status === 'skipped') {
        setMessage({ kind: 'ok', text: `«${label}» — без изменений.` });
      } else {
        setMessage({ kind: 'ok', text: `«${label}» — проиндексировано, чанков: ${res.data.chunks}.` });
      }
    } else {
      setMessage({ kind: 'err', text: errorText(res.data, 'Не удалось загрузить документ.') });
    }
    setBusy(false);
    onChanged();
  }

  /** Big documents are embedded across several passes (provider rate limits). */
  async function continueIngest(docId: string, label: string) {
    for (let round = 1; round <= 10; round += 1) {
      const res = await api(`/api/admin/documents/${docId}`, { method: 'POST' });
      if (!res.ok || !res.data) {
        setMessage({
          kind: 'err',
          text: errorText(res.data, 'Индексация прервалась — нажмите «повторить» позже.'),
        });
        break;
      }
      const status = String(res.data.status);
      if (status === 'ready') {
        setMessage({ kind: 'ok', text: `«${label}» — готово, чанков: ${res.data.chunks}.` });
        break;
      }
      if (status === 'skipped') {
        setMessage({ kind: 'ok', text: `«${label}» — без изменений.` });
        break;
      }
      setMessage({
        kind: 'ok',
        text: `«${label}» — индексирую… ${res.data.chunks}/${res.data.total} чанков`,
      });
      onChanged();
    }
    onChanged();
  }

  async function remove(doc: Doc) {
    if (!window.confirm(`Удалить «${doc.title}» и все его чанки?`)) return;
    const res = await api(`/api/admin/documents/${doc.id}`, { method: 'DELETE' });
    if (!res.ok) setMessage({ kind: 'err', text: errorText(res.data, 'Не удалось удалить.') });
    onChanged();
  }

  return (
    <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">База знаний</h2>
        <button
          type="button"
          onClick={onChanged}
          className="text-xs text-slate-400 hover:text-slate-600"
        >
          обновить
        </button>
      </div>

      <form
        onSubmit={upload}
        className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-slate-300 p-3"
      >
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf"
          className="text-xs text-slate-600"
        />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Название (необязательно)"
          className="w-48 rounded-lg border border-slate-300 px-3 py-1.5 text-xs outline-none focus:border-indigo-500"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Обрабатываю (чанки + эмбеддинги)…' : 'Загрузить и проиндексировать'}
        </button>
        {message && (
          <span className={`w-full text-xs ${message.kind === 'ok' ? 'text-emerald-600' : 'text-red-600'}`}>
            {message.text}
          </span>
        )}
      </form>

      {docs.length === 0 ? (
        <p className="text-xs text-slate-400">
          Пока пусто — загрузите первый документ: он будет разбит на чанки, векторизован и сразу
          попадёт в ответы бота.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {docs.map((doc) => (
            <li key={doc.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-slate-800">{doc.title}</p>
                <p className="truncate text-[11px] text-slate-400">
                  {doc.source ? `${doc.source} · ` : ''}чанков: {doc.chunk_count} · обновлён{' '}
                  {new Date(doc.updated_at).toLocaleString('ru-RU')}
                </p>
                {doc.status === 'error' && doc.error && (
                  <p className="mt-1 text-[11px] text-red-600">{doc.error}</p>
                )}
              </div>
              <StatusBadge status={doc.status} />
              {(doc.status === 'error' ||
                (doc.status === 'processing' &&
                  Date.now() - new Date(doc.updated_at).getTime() > 5 * 60 * 1000)) && (
                <button
                  type="button"
                  onClick={async () => {
                    setMessage(null);
                    await continueIngest(doc.id, doc.title);
                  }}
                  className="rounded-lg border border-amber-200 px-2.5 py-1 text-[11px] text-amber-700 hover:bg-amber-50"
                >
                  повторить
                </button>
              )}
              <button
                type="button"
                onClick={() => void remove(doc)}
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] text-slate-500 hover:border-red-200 hover:text-red-600"
              >
                удалить
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: Doc['status'] }) {
  const styles: Record<Doc['status'], string> = {
    ready: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    processing: 'bg-amber-50 text-amber-700 border-amber-200',
    pending: 'bg-slate-50 text-slate-500 border-slate-200',
    error: 'bg-red-50 text-red-700 border-red-200',
  };
  const labels: Record<Doc['status'], string> = {
    ready: 'готов',
    processing: 'обработка',
    pending: 'ожидает',
    error: 'ошибка',
  };
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-[11px] ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

type BotStats = {
  days: number;
  conversations: number;
  messages: number;
  answers: number;
  up: number;
  down: number;
  avgLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  /** Шкалы/тактики (стиль 2.0, стратег 2.0) — из событий. */
  refusals: number;
  tactics: Array<{ tactic: string; sent: number; goalReached: number; conversion: number }>;
  styleFlags: Array<{ flag: string; count: number }>;
};

const TACTIC_TITLES: Record<string, string> = Object.fromEntries(
  TACTICS.map((tactic) => [tactic.id, tactic.title]),
);

const STYLE_FLAG_LABELS: Record<string, string> = {
  no_cta: 'не было следующего шага',
  no_empathy: 'не было признания чувств',
  humor_leak: 'юмор/эмодзи в негативе',
  cliche: 'шаблонная фраза',
  ty: 'обращение на «ты»',
  repeat: 'повтор формулировок',
};

function StatsPanel({ botId }: { botId: string }) {
  const [stats, setStats] = useState<BotStats | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await api(`/api/admin/stats?botId=${encodeURIComponent(botId)}&days=7`);
    if (res.ok && res.data?.stats) {
      setStats(res.data.stats as BotStats);
    }
    setLoading(false);
  }, [botId]);

  useEffect(() => {
    void load();
  }, [load]);

  const items: Array<{ label: string; value: string }> = stats
    ? [
        { label: 'Диалогов (7 дней)', value: String(stats.conversations) },
        { label: 'Ответов', value: String(stats.answers) },
        { label: 'Оценки', value: `👍 ${stats.up} · 👎 ${stats.down}` },
        {
          label: 'Средний ответ',
          value: stats.avgLatencyMs > 0 ? `${(stats.avgLatencyMs / 1000).toFixed(1)} с` : '—',
        },
        {
          label: 'Токены',
          value: (stats.inputTokens + stats.outputTokens).toLocaleString('ru-RU'),
        },
        { label: 'Стоимость (оценка)', value: `${stats.totalCostUsd.toFixed(4)}` },
        { label: 'Отказы', value: String(stats.refusals ?? 0) },
      ]
    : [];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Статистика за 7 дней</h2>
        <button
          type="button"
          onClick={() => void load()}
          className="text-xs text-slate-400 hover:text-slate-600"
        >
          обновить
        </button>
      </div>
      {loading && !stats ? (
        <div className="mt-3 h-10 animate-pulse rounded-xl bg-slate-100" />
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {items.map((item) => (
            <div key={item.label} className="border border-slate-100 bg-slate-50 px-3 py-2">
              <dt className="text-[11px] text-slate-400">{item.label}</dt>
              <dd className="text-sm font-semibold text-slate-800">{item.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {stats && stats.tactics.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold text-slate-600">
            Тактики (события за {stats.days} дн.)
          </p>
          <table className="mt-2 w-full text-[11px]">
            <thead className="text-left text-slate-400">
              <tr>
                <th className="py-1 font-normal">Тактика</th>
                <th className="py-1 font-normal">Ответов</th>
                <th className="py-1 font-normal">Бесед с целью</th>
                <th className="py-1 font-normal">Конверсия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {stats.tactics.map((row) => (
                <tr key={row.tactic}>
                  <td className="py-1.5 text-slate-700">{TACTIC_TITLES[row.tactic] ?? row.tactic}</td>
                  <td className="py-1.5 text-slate-500">{row.sent}</td>
                  <td className="py-1.5 text-slate-500">{row.goalReached}</td>
                  <td className="py-1.5 text-slate-500">{row.conversion}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[10px] text-slate-400">
            Конверсия — доля бесед с этой тактикой, где цель достигнута (события tactic_used / goal_reached).
          </p>
        </div>
      )}

      {stats && (stats.refusals > 0 || stats.styleFlags.length > 0) && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold text-slate-600">Отказы</p>
            <p className="mt-1 text-sm font-semibold text-slate-800">{stats.refusals}</p>
            <p className="mt-1 text-[10px] text-slate-400">
              «Не звоните», «не надо» — после 2 отказов включается кулдаун продаж.
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-600">Флаги стиля</p>
            {stats.styleFlags.length === 0 ? (
              <p className="mt-1 text-[11px] text-slate-400">Провалов пост-проверок не было.</p>
            ) : (
              <table className="mt-1 w-full text-[11px]">
                <tbody className="divide-y divide-slate-100">
                  {stats.styleFlags.map((row) => (
                    <tr key={row.flag}>
                      <td className="py-1 text-slate-600">{STYLE_FLAG_LABELS[row.flag] ?? row.flag}</td>
                      <td className="py-1 text-right text-slate-500">{row.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
