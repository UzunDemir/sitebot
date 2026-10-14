'use client';

/**
 * Admin panel: «Посетители» — visitor cards for one bot.
 *
 * Left: list (name, last seen, contacts hint). Right: the card — editable
 * name/contacts/tags/notes, auto memory digest, conversations and the event
 * feed. Data comes from /api/admin/visitors (+ /[id]); when sql/0003_seller.sql
 * is not applied yet the panel shows a migration hint.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

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

type VisitorListItem = {
  id: string;
  visitorKey: string;
  name: string | null;
  contacts: Record<string, string>;
  tags: string[];
  notes: string;
  memoryDigest: string;
  doNotDisturb: boolean;
  firstSeen: string;
  lastSeen: string;
  conversationsCount: number;
  /** «05.03» / «05.03.1990» (sql/0004). */
  birthday: string | null;
  preferences: string[];
  complaints: string[];
};

type VisitorPurchase = {
  id: string;
  title: string;
  amount: number | null;
  currency: string;
  status: string;
  orderedAt: string;
};

const PURCHASE_STATUS_LABELS: Record<string, string> = {
  pending: 'в процессе',
  completed: 'куплено',
  canceled: 'отменена',
  refunded: 'возврат',
};

type VisitorConversation = {
  id: string;
  createdAt: string | null;
  lastActiveAt: string | null;
  stage: string;
  outcome: string;
  nudgesSent: number;
  messageCount: number;
};

type VisitorEvent = {
  type: string;
  createdAt: string | null;
  payload: Record<string, unknown>;
};

const CONTACT_LABELS: Array<{ key: string; label: string }> = [
  { key: 'phone', label: 'Телефон' },
  { key: 'email', label: 'Email' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'vk', label: 'VK' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'other', label: 'Другое' },
];

const STAGE_LABELS: Record<string, string> = {
  greeting: 'приветствие',
  qualification: 'квалификация',
  offer: 'предложение',
  objections: 'возражения',
  close: 'закрытие',
  followup: 'дожим',
  done: 'успех',
  lost: 'потерян',
};

const OUTCOME_LABELS: Record<string, string> = {
  in_progress: 'в работе',
  stalled: 'затихла',
  goal_reached: 'цель достигнута',
  closed: 'закрыта',
  lost: 'проиграна',
};

const EVENT_LABELS: Record<string, string> = {
  session_start: 'визит начат',
  page_hidden: 'ушёл со страницы',
  stop_request: 'просьба не писать',
  goal_reached: 'цель достигнута',
  session_closed: 'сессия закрыта',
  nudge_sent: 'написал сам (дожим)',
  nudge_answered: 'ответил на дожим',
};

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

function contactHint(contacts: Record<string, string>): string | null {
  const first = Object.values(contacts)[0];
  return first ?? null;
}

export default function VisitorsPanel({ botId }: { botId: string }) {
  const [visitors, setVisitors] = useState<VisitorListItem[]>([]);
  const [available, setAvailable] = useState(true);
  const [listBusy, setListBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');

  const [detail, setDetail] = useState<{
    visitor: VisitorListItem;
    purchases: VisitorPurchase[];
    purchasesAvailable: boolean;
    conversations: VisitorConversation[];
    events: VisitorEvent[];
  } | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  const [form, setForm] = useState({
    name: '',
    notes: '',
    tags: '',
    dnd: false,
    birthday: '',
    preferences: '',
    complaints: '',
  });
  const [contacts, setContacts] = useState<Record<string, string>>({});
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [purchaseForm, setPurchaseForm] = useState({ title: '', amount: '', status: 'completed' });
  const [purchaseBusy, setPurchaseBusy] = useState(false);

  const loadList = useCallback(async (): Promise<void> => {
    setListBusy(true);
    const res = await api(`/api/admin/visitors?botId=${encodeURIComponent(botId)}`);
    setListBusy(false);
    if (res.ok && res.data) {
      setAvailable(res.data.available !== false);
      setVisitors(Array.isArray(res.data.visitors) ? res.data.visitors : []);
    } else if (res.status === 401) {
      setVisitors([]);
    }
  }, [botId]);

  const loadDetail = useCallback(async (visitorId: string): Promise<void> => {
    if (!visitorId) return;
    setDetailBusy(true);
    const res = await api(`/api/admin/visitors/${encodeURIComponent(visitorId)}`);
    setDetailBusy(false);
    if (res.ok && res.data?.visitor) {
      setDetail({
        visitor: res.data.visitor as VisitorListItem,
        purchases: Array.isArray(res.data.purchases) ? (res.data.purchases as VisitorPurchase[]) : [],
        purchasesAvailable: res.data.purchasesAvailable !== false,
        conversations: Array.isArray(res.data.conversations) ? res.data.conversations : [],
        events: Array.isArray(res.data.events) ? res.data.events : [],
      });
    } else {
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    setSelectedId('');
    setDetail(null);
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  // Sync the edit form when a card arrives.
  useEffect(() => {
    if (!detail) return;
    setForm({
      name: detail.visitor.name ?? '',
      notes: detail.visitor.notes ?? '',
      tags: (detail.visitor.tags ?? []).join(', '),
      dnd: detail.visitor.doNotDisturb === true,
      birthday: detail.visitor.birthday ?? '',
      preferences: (detail.visitor.preferences ?? []).join('\n'),
      complaints: (detail.visitor.complaints ?? []).join('\n'),
    });
    setContacts({ ...(detail.visitor.contacts ?? {}) });
    setSaveMessage(null);
  }, [detail]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return visitors;
    return visitors.filter((visitor) => {
      const haystack = [
        visitor.name ?? '',
        ...Object.values(visitor.contacts ?? {}),
        ...(visitor.tags ?? []),
        visitor.notes ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [visitors, query]);

  async function save() {
    if (!detail || saveBusy) return;
    setSaveBusy(true);
    setSaveMessage(null);
    const res = await api(`/api/admin/visitors/${encodeURIComponent(detail.visitor.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: form.name,
        notes: form.notes,
        tags: form.tags,
        contacts,
        do_not_disturb: form.dnd,
        birthday: form.birthday,
        preferences: splitLines(form.preferences),
        complaints: splitLines(form.complaints),
      }),
    });
    setSaveBusy(false);
    if (res.ok && res.data?.visitor) {
      const updated = res.data.visitor as VisitorListItem;
      setDetail((prev) => (prev ? { ...prev, visitor: updated } : prev));
      setVisitors((prev) => prev.map((v) => (v.id === updated.id ? { ...v, ...updated } : v)));
      setSaveMessage({ kind: 'ok', text: 'Сохранено.' });
    } else {
      setSaveMessage({ kind: 'err', text: 'Не удалось сохранить карточку.' });
    }
  }

  async function addPurchase() {
    if (!detail || purchaseBusy) return;
    const title = purchaseForm.title.trim();
    if (!title) return;
    const amountDigits = purchaseForm.amount.replace(/\s+/g, '').replace(',', '.');
    const amount = amountDigits ? Number(amountDigits) : null;
    setPurchaseBusy(true);
    const res = await api('/api/admin/purchases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        visitorId: detail.visitor.id,
        title,
        amount: amount !== null && Number.isFinite(amount) ? amount : null,
        status: purchaseForm.status,
      }),
    });
    setPurchaseBusy(false);
    if (res.ok) {
      setPurchaseForm({ title: '', amount: '', status: 'completed' });
      void loadDetail(detail.visitor.id);
    }
  }

  async function removePurchase(id: string) {
    if (!detail || purchaseBusy) return;
    setPurchaseBusy(true);
    const res = await api(`/api/admin/purchases/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setPurchaseBusy(false);
    if (res.ok) void loadDetail(detail.visitor.id);
  }

  return (
    <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Посетители</h2>
        <button
          type="button"
          onClick={() => void loadList()}
          className="text-xs text-slate-400 hover:text-slate-600"
        >
          {listBusy ? 'обновляю…' : 'обновить'}
        </button>
      </div>

      {!available && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          Карточки посетителей ещё не включены: выполните{' '}
          <code className="rounded bg-amber-100 px-1">sql/0003_seller.sql</code> в Supabase SQL Editor
          и обновите страницу.
        </div>
      )}

      {available && visitors.length === 0 && (
        <p className="text-xs text-slate-400">
          Пока пусто. Карточка появится, как только посетитель напишет боту: имя, контакты и
          заметки собираются автоматически, а заметки и теги можно править здесь.
        </p>
      )}

      {available && visitors.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          <div className="space-y-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск: имя, телефон, заметка…"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs text-slate-900 outline-none focus:border-indigo-500"
            />
            <ul className="max-h-[560px] space-y-1 overflow-y-auto pr-1">
              {filtered.map((visitor) => (
                <li key={visitor.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(visitor.id)}
                    className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                      visitor.id === selectedId
                        ? 'border-indigo-200 bg-indigo-50'
                        : 'border-slate-100 hover:bg-slate-50'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium text-slate-800">
                        {visitor.name ?? 'Аноним'}
                      </span>
                      {visitor.doNotDisturb && (
                        <span className="rounded-full border border-slate-200 px-1.5 py-0.5 text-[9px] text-slate-400">
                          DND
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-slate-400">
                      {contactHint(visitor.contacts) ?? 'контактов нет'} · диалогов:{' '}
                      {visitor.conversationsCount} · {formatDate(visitor.lastSeen)}
                    </span>
                  </button>
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="px-3 py-2 text-[11px] text-slate-400">Ничего не найдено.</li>
              )}
            </ul>
          </div>

          <div className="min-w-0">
            {!detail && (
              <p className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-xs text-slate-400">
                {detailBusy ? 'Загружаю карточку…' : 'Выберите посетителя слева.'}
              </p>
            )}

            {detail && (
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-slate-600">Карточка</p>
                    <span className="text-[10px] text-slate-400">
                      первый визит: {formatDate(detail.visitor.firstSeen)} · последний:{' '}
                      {formatDate(detail.visitor.lastSeen)}
                    </span>
                  </div>

                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-xs text-slate-500">
                      Имя
                      <input
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                        placeholder="не определено"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
                      />
                    </label>
                    <label className="space-y-1 text-xs text-slate-500">
                      Теги (через запятую)
                      <input
                        value={form.tags}
                        onChange={(e) => setForm({ ...form, tags: e.target.value })}
                        placeholder="опт, повторный, СПб"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
                      />
                    </label>
                  </div>

                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-xs text-slate-500">
                      День рождения
                      <input
                        value={form.birthday}
                        onChange={(e) => setForm({ ...form, birthday: e.target.value })}
                        placeholder="05.03 или 05.03.1990"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
                      />
                    </label>
                  </div>

                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {CONTACT_LABELS.map(({ key, label }) => (
                      <label key={key} className="space-y-1 text-xs text-slate-500">
                        {label}
                        <input
                          value={contacts[key] ?? ''}
                          onChange={(e) => setContacts({ ...contacts, [key]: e.target.value })}
                          placeholder="—"
                          className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
                        />
                      </label>
                    ))}
                  </div>

                  <label className="mt-3 block space-y-1 text-xs text-slate-500">
                    Заметки владельца (видны только в админке)
                    <textarea
                      rows={3}
                      value={form.notes}
                      onChange={(e) => setForm({ ...form, notes: e.target.value })}
                      placeholder="Договорились созвониться в четверг, просил скидку…"
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
                    />
                  </label>

                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-xs text-slate-500">
                      Предпочтения (по одному в строке)
                      <textarea
                        rows={3}
                        value={form.preferences}
                        onChange={(e) => setForm({ ...form, preferences: e.target.value })}
                        placeholder={'любит оверсайз\nне любит кожу'}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
                      />
                    </label>
                    <label className="space-y-1 text-xs text-slate-500">
                      Претензии (по одной в строке)
                      <textarea
                        rows={3}
                        value={form.complaints}
                        onChange={(e) => setForm({ ...form, complaints: e.target.value })}
                        placeholder="задержали прошлый заказ"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500"
                      />
                    </label>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-2 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={form.dnd}
                        onChange={(e) => setForm({ ...form, dnd: e.target.checked })}
                        className="h-4 w-4"
                      />
                      Не беспокоить (do not disturb)
                    </label>
                    <button
                      type="button"
                      onClick={() => void save()}
                      disabled={saveBusy}
                      className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
                    >
                      {saveBusy ? 'Сохраняю…' : 'Сохранить карточку'}
                    </button>
                    {saveMessage && (
                      <span
                        className={`text-xs ${
                          saveMessage.kind === 'ok' ? 'text-emerald-600' : 'text-red-600'
                        }`}
                      >
                        {saveMessage.text}
                      </span>
                    )}
                  </div>

                  {detail.visitor.memoryDigest && (
                    <details className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
                      <summary className="cursor-pointer text-[11px] font-medium text-slate-500">
                        Память бота (собирается автоматически)
                      </summary>
                      <ul className="mt-2 space-y-1 text-[11px] text-slate-600">
                        {detail.visitor.memoryDigest.split('\n').map((line, index) => (
                          <li key={index}>• {line}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>

                <div className="rounded-xl border border-slate-100 p-4">
                  <p className="text-xs font-semibold text-slate-600">
                    Покупки ({(detail.purchases ?? []).length})
                  </p>
                  {!detail.purchasesAvailable && (
                    <p className="mt-2 text-[11px] text-amber-700">
                      Покупки требуют миграции sql/0004_card.sql.
                    </p>
                  )}
                  {(detail.purchases ?? []).length === 0 ? (
                    <p className="mt-2 text-[11px] text-slate-400">Покупок пока нет.</p>
                  ) : (
                    <ul className="mt-2 divide-y divide-slate-100">
                      {(detail.purchases ?? []).map((purchase) => (
                        <li key={purchase.id} className="flex flex-wrap items-center gap-2 py-2 text-[11px]">
                          <span className="text-slate-400">{formatDate(purchase.orderedAt)}</span>
                          <span className="font-medium text-slate-700">{purchase.title}</span>
                          {purchase.amount !== null && (
                            <span className="text-slate-500">
                              {purchase.amount.toLocaleString('ru-RU')}{' '}
                              {purchase.currency === 'RUB' ? '₽' : purchase.currency}
                            </span>
                          )}
                          <span className="rounded-full border border-slate-200 px-2 py-0.5 text-slate-500">
                            {PURCHASE_STATUS_LABELS[purchase.status] ?? purchase.status}
                          </span>
                          <button
                            type="button"
                            onClick={() => void removePurchase(purchase.id)}
                            disabled={purchaseBusy}
                            className="ml-auto text-slate-400 hover:text-red-600 disabled:opacity-50"
                          >
                            удалить
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_110px_130px_auto]">
                    <input
                      value={purchaseForm.title}
                      onChange={(e) => setPurchaseForm({ ...purchaseForm, title: e.target.value })}
                      placeholder="Пуховик Arctic"
                      className="rounded-xl border border-slate-300 px-3 py-2 text-xs text-slate-900 outline-none focus:border-indigo-500"
                    />
                    <input
                      value={purchaseForm.amount}
                      onChange={(e) => setPurchaseForm({ ...purchaseForm, amount: e.target.value })}
                      placeholder="12 900"
                      inputMode="numeric"
                      className="rounded-xl border border-slate-300 px-3 py-2 text-xs text-slate-900 outline-none focus:border-indigo-500"
                    />
                    <select
                      value={purchaseForm.status}
                      onChange={(e) => setPurchaseForm({ ...purchaseForm, status: e.target.value })}
                      className="rounded-xl border border-slate-300 px-2 py-2 text-xs text-slate-900 outline-none focus:border-indigo-500"
                    >
                      <option value="completed">куплено</option>
                      <option value="pending">в процессе</option>
                      <option value="canceled">отменена</option>
                      <option value="refunded">возврат</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => void addPurchase()}
                      disabled={purchaseBusy || !purchaseForm.title.trim()}
                      className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 disabled:opacity-50"
                    >
                      Добавить
                    </button>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-100 p-4">
                  <p className="text-xs font-semibold text-slate-600">
                    Беседы ({detail.conversations.length})
                  </p>
                  {detail.conversations.length === 0 ? (
                    <p className="mt-2 text-[11px] text-slate-400">Бесед пока нет.</p>
                  ) : (
                    <ul className="mt-2 divide-y divide-slate-100">
                      {detail.conversations.map((conv) => (
                        <li key={conv.id} className="flex flex-wrap items-center gap-2 py-2 text-[11px]">
                          <span className="text-slate-600">{formatDate(conv.lastActiveAt ?? conv.createdAt)}</span>
                          <span className="rounded-full border border-slate-200 px-2 py-0.5 text-slate-500">
                            {STAGE_LABELS[conv.stage] ?? conv.stage}
                          </span>
                          <span className="rounded-full border border-slate-200 px-2 py-0.5 text-slate-500">
                            {OUTCOME_LABELS[conv.outcome] ?? conv.outcome}
                          </span>
                          <span className="text-slate-400">сообщений: {conv.messageCount}</span>
                          {conv.nudgesSent > 0 && (
                            <span className="text-slate-400">касаний: {conv.nudgesSent}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="rounded-xl border border-slate-100 p-4">
                  <p className="text-xs font-semibold text-slate-600">
                    События ({detail.events.length})
                  </p>
                  {detail.events.length === 0 ? (
                    <p className="mt-2 text-[11px] text-slate-400">Событий пока нет.</p>
                  ) : (
                    <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
                      {detail.events.map((event, index) => (
                        <li key={index} className="flex items-center gap-2 text-[11px]">
                          <span className="text-slate-400">{formatDate(event.createdAt)}</span>
                          <span className="text-slate-600">
                            {EVENT_LABELS[event.type] ?? event.type}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
