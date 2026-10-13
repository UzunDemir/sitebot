/**
 * Memory acceptance test (Phase 1): a long dialog (20+ messages) must
 * remember a fact from its very beginning — including after a simulated
 * reload with an EMPTY client: the past dialog is not re-sent, the server
 * rebuilds the model context from the stored conversation (memory is
 * server-side; the widget shows a fresh feed).
 *
 * Local mode (default): spawns `npm run start` (run `npm run build` first).
 * Remote mode: set SMOKE_BASE_URL.
 *
 * Requires .env.local (service key): the test lifts «Память диалога» to a
 * 50-message window for the run (restored afterwards) and deletes its test
 * conversation.
 *
 * Usage: npm run smoke:memory
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

const NAME = 'Игорь';
const NEEDED_MESSAGES = 24; // 12 ходов × (user + assistant); критерий Ф1 — 20+
const TEMP_DEPTH = 50; // временный размер окна памяти на время прогона
const FILLERS = [
  'Сколько идёт доставка по России?',
  'Как вернуть неподошедший товар?',
  'Какие способы оплаты вы принимаете?',
  'Распространяется ли гарантия на обувь?',
  'Как правильно выбрать размер?',
  'Как работают бонусы за покупки?',
  'Можно ли обменять товар на другой?',
  'Как связаться с поддержкой?',
  'Есть ли бесплатная доставка?',
  'Сколько стоит доставка в другой город?',
  'Можно ли оплатить заказ картой при получении?',
];
const LAST_QUESTION = 'Кстати, как меня зовут? Напомни, я говорил в начале.';

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

/** One chat turn with the WHOLE dialog resent — mirrors how the widget works. */
async function ask(botKey, sessionKey, dialog, text) {
  sequence += 1;
  dialog.push({ id: `m${sequence}`, role: 'user', parts: [{ type: 'text', text }] });
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ botKey, sessionKey, messages: dialog }),
  });
  const raw = await res.text();
  const answer = answerOf(raw);
  dialog.push({ id: `a${sequence}`, role: 'assistant', parts: [{ type: 'text', text: answer }] });
  return { ok: res.ok, status: res.status, answer };
}

let bot = null;
let restoreSettings = null;
let sessionKey = '';

try {
  console.log(MANAGE_SERVER ? '── ожидание сервера (npm run start) ──' : `── проверка ${BASE} ──`);
  const up = await waitForServer();
  if (!up) {
    console.error('❌ сервер не поднялся');
    if (MANAGE_SERVER) console.error(serverLog.slice(-1200));
    process.exit(1);
  }
  console.log('  ✓ цель отвечает');

  // --- bot
  const botsRes = await supabase
    .from('bots')
    .select('id, name, public_key, settings')
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1);
  bot = botsRes.data?.[0] ?? null;
  if (!bot) {
    console.error('❌ нет активных ботов — сначала npm run seed');
    process.exit(1);
  }
  console.log(`  ✓ бот «${bot.name}» (${bot.public_key})`);

  // Wide memory window for the acceptance run (restored in finally).
  const depth = bot.settings?.historyDepth;
  if (depth !== TEMP_DEPTH) {
    restoreSettings = bot.settings ?? {};
    const upd = await supabase
      .from('bots')
      .update({ settings: { ...restoreSettings, historyDepth: TEMP_DEPTH } })
      .eq('id', bot.id);
    if (upd.error) throw upd.error;
    console.log(`  ↷ «Память диалога» на время теста: ${TEMP_DEPTH} (было: ${depth ?? 'по умолчанию'})`);
  }

  sessionKey = `memory-${Date.now()}`;
  const dialog = [];

  // 1) turn 1: the fact to remember
  const first = await ask(
    bot.public_key,
    sessionKey,
    dialog,
    `Привет! Меня зовут ${NAME}. Запомни моё имя — оно ещё понадобится.`,
  );
  check('ход 1: ответ получен', first.ok, `HTTP ${first.status}`);

  // 2) fillers — grow the dialog past 20 messages
  let fillersOk = 0;
  for (const question of FILLERS) {
    const turn = await ask(bot.public_key, sessionKey, dialog, question);
    if (turn.ok) fillersOk += 1;
  }
  check(`промежуточные ходы: ${fillersOk}/${FILLERS.length}`, fillersOk === FILLERS.length);
  check(`диалог набрал ${NEEDED_MESSAGES}+ сообщений`, dialog.length >= NEEDED_MESSAGES, `${dialog.length} шт.`);

  // 3) «reload»: виджет не показывает прошлую переписку, но беседа
  // целиком лежит в БД (память серверная).
  const histRes = await fetch(
    `${BASE}/api/chat/history?botKey=${encodeURIComponent(bot.public_key)}&sessionKey=${encodeURIComponent(sessionKey)}`,
  );
  const histJson = await histRes.json().catch(() => null);
  const stored = Array.isArray(histJson?.messages) ? histJson.messages : [];
  check('/api/chat/history → 200', histRes.ok, `HTTP ${histRes.status}`);
  check('беседа сохранена целиком', stored.length >= NEEDED_MESSAGES, `${stored.length} сообщ.`);
  check('в истории есть самое первое сообщение', JSON.stringify(stored[0]?.parts ?? []).includes(NAME));
  check('история содержит data-feedback (оценки доступны)', JSON.stringify(stored).includes('data-feedback'));

  // 4) «пустой» клиент отправляет только новый вопрос — контекст сервер
  // собирает сам из БД, память не зависит от того, что показывает виджет.
  const emptyClient = [];
  const last = await ask(bot.public_key, sessionKey, emptyClient, LAST_QUESTION);
  check('после «перезагрузки»: ответ получен', last.ok, `HTTP ${last.status}`);
  check(
    `бот помнит имя через ${stored.length}+ сообщений (клиент пуст)`,
    last.answer.toLowerCase().includes(NAME.toLowerCase()),
    last.answer.replace(/\s+/g, ' ').slice(0, 160),
  );
} catch (err) {
  console.error('❌ smoke-memory упал с ошибкой:', err instanceof Error ? err.message : err);
  failures += 1;
} finally {
  if (bot && restoreSettings !== null) {
    const upd = await supabase.from('bots').update({ settings: restoreSettings }).eq('id', bot.id);
    if (upd.error) console.error(`⚠ не удалось восстановить настройки бота: ${upd.error.message}`);
    else console.log('  ↷ «Память диалога» восстановлена');
  }
  if (bot && sessionKey) {
    const del = await supabase
      .from('conversations')
      .delete()
      .eq('bot_id', bot.id)
      .eq('session_key', sessionKey);
    if (del.error) console.error(`⚠ не удалось удалить тестовую беседу: ${del.error.message}`);
    else console.log(`  ↷ тестовая беседа удалена: ${sessionKey}`);
  }
  stopServer();
}

if (failures > 0) {
  console.error(`\n❌ smoke-memory: ${failures} проверок провалено`);
  process.exit(1);
}
console.log('\n✅ smoke-memory: все проверки пройдены');
