'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
      <div className="animate-pulse rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="h-6 w-40 rounded bg-slate-100" />
        <div className="mt-4 h-24 w-full rounded-xl bg-slate-100" />
      </div>
    );
  }

  if (phase === 'login') {
    return <LoginCard notConfigured={notConfigured} onLoggedIn={loadBots} />;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-600 text-lg text-white">
          ⚙️
        </div>
        <div>
          <h1 className="text-sm font-semibold text-slate-900">sitebot — админка</h1>
          <p className="text-xs text-slate-500">База знаний, модель и промпт — без кода и деплоя</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <a
            href="/"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            ← к боту
          </a>
          <button
            type="button"
            onClick={async () => {
              await api('/api/admin/logout', { method: 'POST' });
              setBots([]);
              setDocs([]);
              setSelectedBotId('');
              setPhase('login');
            }}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
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

      {selectedBot && (
        <>
          <BotSettings
            key={selectedBot.id}
            bot={selectedBot}
            models={models}
            onSaved={(bot) => setBots((prev) => prev.map((b) => (b.id === bot.id ? bot : b)))}
          />
          <DocumentsPanel
            botId={selectedBot.id}
            docs={docs}
            onChanged={() => void loadDocs(selectedBot.id)}
          />
        </>
      )}
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
  });
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
      body: JSON.stringify(form),
    });
    setBusy(false);
    if (res.ok && res.data?.bot) {
      onSaved(res.data.bot as Bot);
      setMessage({ kind: 'ok', text: 'Сохранено — применится к следующим ответам.' });
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
          title="Публичный ключ бота — понадобится виджету (фаза 3)"
        >
          {bot.public_key}
        </code>
      </div>

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

      <label className="block space-y-1 text-xs text-slate-500">
        Системный промпт
        <textarea
          rows={5}
          value={form.system_prompt}
          onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
          className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
        />
      </label>

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
