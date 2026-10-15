/**
 * Memory-epoch acceptance test («память никогда не удаляется», 15.10.2026).
 *
 * Checks:
 *   1. знакомство -> карточка с именем (извлечение фактов)
 *   2. покупка до сброса + счётчики сообщений «до»
 *   3. POST /api/chat/forget (кнопка) -> ok, mode:soft
 *      карточка сохранена, активная память обнулена, эпоха записана
 *      (snapshot с именем), беседа закрыта (memory_reset),
 *      сообщения/покупки/события сохранены (память НЕ удаляется)
 *   4. GET /api/chat/history -> пустая лента новой эпохи, имя скрыто
 *   5. текст «забудь всё» -> канонический ответ, вторая эпоха (source=chat)
 *   6. возврат: новое сообщение оживляет беседу (in_progress)
 *
 * Local mode (default): spawns `npm run start` (run `npm run build` first).
 * Remote mode: set SMOKE_BASE_URL.
 * Requires .env.local (service key) and sql/0005_memory_reset.sql.
 *
 * Usage: npm run smoke:reset
 */

import { readFileSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from '@supabase/supabase-js';

const REMOTE_BASE = (process.env.SMOKE_BASE_URL ?? '').trim().replace(/\/+$/, '');
const BASE = REMOTE_BASE || 'http://localhost:3000';
const MANAGE_SERVER = !REMOTE_BASE;

// --- .env.local (service key for the DB side: memory setting + cleanup)
const env = {};
try {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i === -1) continue;
    env[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
} catch {
  console.error('❌ .env.local не найден — нужен сервисный ключ для чистки данных.');
  process.exit(1);
}
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY);

function isMissingRelation(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === '42P01' || err.code === 'PGRST205') return true;
  return (
    typeof err.message === 'string' &&
    /relation .* does not exist|could not find the table|schema cache/i.test(err.message)
  );
}

const NAME = 'Игорь';
const PHONE = '8-800-555-35-35';

// --- local server management (same pattern as the other smokes)
const child = MANAGE_SERVER
  ? spawn('cmd.exe', ['/d', '/s', '/c', 'npm run start'], { cwd: process.cwd(), windowsHide: true })
  : null;
let serverLog = '';
if (child) {
  child.stdout.on('data', (d) => {
    serverLog += d.toString();
  });
  child.stderr.on('data', (d) => {
    serverLog += d.toString();
  });
}
function stopServer() {
  if (!child) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch {
    // already stopped
  }
}

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '  ✓' : '  ❌'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures += 1;
};

async function waitForServer() {
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    await sleep(1000);
    try {
      const res = await fetch(`${BASE}/api/bot`);
      if (res.status > 0) return true;
    } catch {
      // not up yet
    }
  }
  return false;
}

function extractStream(raw, field) {
  const pattern = new RegExp(`"${field}":"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  return [...raw.matchAll(pattern)].map((m) => m[1]);
}

function answerOf(raw) {
  return [...extractStream(raw, 'text'), ...extractStream(raw, 'delta')]
    .join('')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"');
}

let sequence = 0;

/** One chat turn (the dialog is resent like the widget does). */
async function ask(botKey, sessionKey, visitorKey, dialog, text) {
  sequence += 1;
  dialog.push({ id: `m${sequence}`, role: 'user', parts: [{ type: 'text', text }] });
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ botKey, sessionKey, visitorKey, messages: dialog }),
  });
  const raw = await res.text();
  const answer = answerOf(raw);
  dialog.push({ id: `a${sequence}`, role: 'assistant', parts: [{ type: 'text', text: answer }] });
  return { ok: res.ok, status: res.status, answer };
}

let bot = null;
let sessionKey = '';
let session2 = '';
let visitorKey = '';
let cardId = null;

try {
  console.log(MANAGE_SERVER ? '── ожидание сервера (npm run start) ──' : `── проверка ${BASE} ──`);
  const up = await waitForServer();
  if (!up) {
    console.error('❌ сервер не поднялся');
    if (MANAGE_SERVER) console.error(serverLog.slice(-1200));
    process.exit(1);
  }
  console.log('  ✓ цель отвечает');

  const botsRes = await supabase
    .from('bots')
    .select('id, name, public_key')
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1);
  bot = botsRes.data?.[0] ?? null;
  if (!bot) {
    console.error('❌ нет активных ботов — сначала npm run seed');
    process.exit(1);
  }
  console.log(`  ✓ бот «${bot.name}» (${bot.public_key})`);

  // Миграция 0005 должна быть применена.
  const probe = await supabase.from('memory_resets').select('id', { count: 'exact', head: true }).limit(1);
  if (probe.error && isMissingRelation(probe.error)) {
    console.error('❌ нет таблицы memory_resets — примените sql/0005_memory_reset.sql');
    process.exit(1);
  }

  sessionKey = `reset-${Date.now()}`;
  visitorKey = `reset-v-${Date.now()}`;
  const dialog = [];

  // --- 1) знакомство: имя попадает в карточку
  const intro = await ask(
    bot.public_key,
    sessionKey,
    visitorKey,
    dialog,
    `Привет! Меня зовут ${NAME}, мой телефон ${PHONE}. Интересует доставка пуховиков.`,
  );
  check('ход 1: ответ получен', intro.ok, `HTTP ${intro.status}`);

  let card = null;
  for (let attempt = 0; attempt < 15 && !card; attempt += 1) {
    await sleep(1000);
    const res = await supabase
      .from('visitors')
      .select('id, name, contacts, memory_digest')
      .eq('bot_id', bot.id)
      .eq('visitor_key', visitorKey)
      .maybeSingle();
    if (res.data) card = res.data;
  }
  cardId = card?.id ?? null;
  check('карточка создана', Boolean(cardId));
  check('имя извлечено', card?.name === NAME, `name=${card?.name ?? 'null'}`);

  // покупка до сброса — должна выжить
  const buyIns = await supabase
    .from('purchases')
    .insert({ bot_id: bot.id, visitor_id: cardId, title: 'Смоук-пуховик', amount: 1234 })
    .select('id')
    .single();
  check('покупка добавлена', !buyIns.error, buyIns.error?.message ?? '');

  const convBefore = await supabase
    .from('conversations')
    .select('id')
    .eq('bot_id', bot.id)
    .eq('session_key', sessionKey)
    .maybeSingle();
  const convId = convBefore.data?.id ?? null;
  const msgBefore = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', convId);
  const msgBeforeCount = msgBefore.count ?? 0;

  // --- 2) кнопка «Забыть меня» -> новая эпоха
  console.log('── /api/chat/forget (кнопка) ──');
  const forgetRes = await fetch(`${BASE}/api/chat/forget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ botKey: bot.public_key, visitorKey, sessionKey }),
  });
  const forgetJson = await forgetRes.json().catch(() => null);
  check(
    '/api/chat/forget → ok (soft)',
    forgetRes.ok && forgetJson?.ok === true && forgetJson?.mode === 'soft',
    `HTTP ${forgetRes.status}`,
  );

  const cardAfter = await supabase
    .from('visitors')
    .select('id, name, contacts, memory_digest')
    .eq('id', cardId)
    .maybeSingle();
  check('карточка сохранена (не удалена)', Boolean(cardAfter.data?.id));
  check(
    'активная память обнулена (имя/контакты/дайджест)',
    !cardAfter.data?.name &&
      Object.keys(cardAfter.data?.contacts ?? {}).length === 0 &&
      !(cardAfter.data?.memory_digest ?? ''),
    `name=${cardAfter.data?.name ?? 'null'}`,
  );

  const resets = await supabase
    .from('memory_resets')
    .select('id, source, snapshot')
    .eq('visitor_id', cardId)
    .order('created_at', { ascending: true });
  check('эпоха записана (memory_resets=1)', (resets.data ?? []).length === 1, `rows=${(resets.data ?? []).length}`);
  check(
    'снимок эпохи содержит имя',
    resets.data?.[0]?.snapshot?.name === NAME,
    JSON.stringify(resets.data?.[0]?.snapshot ?? {}),
  );

  const convAfter = await supabase.from('conversations').select('outcome').eq('id', convId).maybeSingle();
  check('беседа закрыта (memory_reset)', convAfter.data?.outcome === 'memory_reset', `outcome=${convAfter.data?.outcome}`);

  const msgAfter = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', convId);
  check(
    'сообщения сохранены (память не удаляется)',
    (msgAfter.count ?? 0) === msgBeforeCount,
    `${msgBeforeCount} → ${msgAfter.count ?? 0}`,
  );
  const buys = await supabase.from('purchases').select('id').eq('visitor_id', cardId);
  check('покупки сохранены', (buys.data ?? []).length === 1, `rows=${(buys.data ?? []).length}`);
  const evts = await supabase
    .from('events')
    .select('id')
    .eq('visitor_id', cardId)
    .eq('type', 'memory_reset');
  check('событие memory_reset записано', (evts.data ?? []).length === 1, `rows=${(evts.data ?? []).length}`);

  // --- 3) история новой эпохи пуста, имя скрыто
  const hist = await fetch(
    `${BASE}/api/chat/history?botKey=${encodeURIComponent(bot.public_key)}&sessionKey=${encodeURIComponent(sessionKey)}&visitorKey=${encodeURIComponent(visitorKey)}&limit=50`,
  );
  const histJson = await hist.json().catch(() => null);
  check(
    'история: активное окно пусто',
    (histJson?.messages ?? []).length === 0,
    `сообщений: ${(histJson?.messages ?? []).length}`,
  );
  check('история: имя скрыто', !histJson?.visitor?.name, `name=${histJson?.visitor?.name ?? 'null'}`);

  // --- 4) текстовая просьба «забудь всё» -> вторая эпоха
  session2 = `reset2-${Date.now()}`;
  const dialog2 = [];
  const forgetAsk = await ask(bot.public_key, session2, visitorKey, dialog2, 'забудь всё, пожалуйста');
  check('текст «забудь»: ответ получен', forgetAsk.ok, `HTTP ${forgetAsk.status}`);
  check(
    'текст «забудь»: канонический ответ',
    (forgetAsk.answer ?? '').includes('с чистого листа'),
    (forgetAsk.answer ?? '').slice(0, 90),
  );

  const resets2 = await supabase
    .from('memory_resets')
    .select('id, source')
    .eq('visitor_id', cardId)
    .order('created_at', { ascending: true });
  check(
    'вторая эпоха записана (source=chat)',
    (resets2.data ?? []).length === 2 && resets2.data?.[1]?.source === 'chat',
    `rows=${(resets2.data ?? []).length}, last=${resets2.data?.[1]?.source ?? '—'}`,
  );

  // --- 5) возврат оживляет беседу
  const back = await ask(bot.public_key, session2, visitorKey, dialog2, 'привет ещё раз!');
  check('возврат: ответ получен', back.ok, `HTTP ${back.status}`);
  const conv2 = await supabase
    .from('conversations')
    .select('outcome')
    .eq('bot_id', bot.id)
    .eq('session_key', session2)
    .maybeSingle();
  check('возврат: беседа ожила (in_progress)', conv2.data?.outcome === 'in_progress', `outcome=${conv2.data?.outcome}`);
} catch (err) {
  console.error('❌ smoke-reset упал с ошибкой:', err instanceof Error ? err.message : err);
  failures += 1;
} finally {
  // Чистим только тестовые данные.
  try {
    if (bot) {
      for (const sk of [sessionKey, session2]) {
        if (sk) await supabase.from('conversations').delete().eq('bot_id', bot.id).eq('session_key', sk);
      }
      if (cardId) {
        await supabase.from('events').delete().eq('visitor_id', cardId);
        await supabase.from('memory_resets').delete().eq('visitor_id', cardId);
        await supabase.from('purchases').delete().eq('visitor_id', cardId);
        await supabase.from('conversations').delete().eq('visitor_id', cardId);
        await supabase.from('visitors').delete().eq('id', cardId);
      }
    }
  } catch {
    // best-effort cleanup
  }
  stopServer();
  if (failures === 0) {
    console.log('');
    console.log('✅ smoke:reset — все проверки пройдены');
    process.exit(0);
  }
  console.error('');
  console.error(`❌ smoke:reset — провалено проверок: ${failures}`);
  if (MANAGE_SERVER) console.error(serverLog.slice(-1500));
  process.exit(1);
}
