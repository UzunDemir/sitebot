/**
 * Nudge acceptance test (Ф3): proactive follow-ups for a silent visitor.
 *
 * Local mode (default): spawns `npm run start` (run `npm run build` first).
 * Remote mode: set SMOKE_BASE_URL.
 *
 * Requires sql/0003_seller.sql applied and .env.local (service key).
 * The test temporarily relaxes the bot's nudge timing (15 s / 60 s) and
 * restores the original settings at the end.
 *
 * Checks:
 *   1. a fresh answer arms the engine: too_early right away (15 s pause)
 *   2. after the pause the nudge is allowed: text, is_proactive message,
 *      conversation counters (nudges_sent, last_nudge_at, stage=followup),
 *      nudge_sent event
 *   3. the interval guard: an immediate second call is too_early
 *   4. an answer cancels the pending nudge (nudges_sent reset + nudge_answered)
 *   5. DND: do_not_disturb → denied with reason dnd
 *   6. lost dialog: one reactivation touch (then limit), a new message revives it
 *   7. stop-words: canned reply, DND set, outcome stopped, stop_request event
 *   8. quiet hours: the window containing "now" denies the touch
 *
 * Usage: npm run smoke:nudge
 */

import { readFileSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from '@supabase/supabase-js';

const REMOTE_BASE = (process.env.SMOKE_BASE_URL ?? '').trim().replace(/\/+$/, '');
const BASE = REMOTE_BASE || 'http://localhost:3000';
const MANAGE_SERVER = !REMOTE_BASE;

// --- .env.local (service key)
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
  console.error('❌ .env.local не найден — нужен сервисный ключ.');
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

const FIRST_DELAY_SEC = 15;
const INTERVAL_SEC = 60;

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

let bot = null;
let originalSettings = null;
let sessionKey = '';
let sessionKey2 = '';
let visitorKey = '';

/** One dialog turn (like the widget: the whole dialog is resent). */
async function chat(session, dialog, text) {
  dialog.push({ id: `m${dialog.length}`, role: 'user', parts: [{ type: 'text', text }] });
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ botKey: bot.public_key, sessionKey: session, visitorKey, messages: dialog }),
  });
  const raw = await res.text();
  const answer = answerOf(raw);
  dialog.push({ id: `a${dialog.length}`, role: 'assistant', parts: [{ type: 'text', text: answer }] });
  return { ok: res.ok, status: res.status, answer };
}

async function nudge(session, tz = 'UTC') {
  const res = await fetch(`${BASE}/api/chat/nudge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ botKey: bot.public_key, sessionKey: session, visitorKey, tz }),
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

async function conversationOf(session) {
  const res = await supabase
    .from('conversations')
    .select('id, stage, outcome, nudges_sent, last_nudge_at, visitor_id')
    .eq('bot_id', bot.id)
    .eq('session_key', session)
    .maybeSingle();
  if (res.error) throw res.error;
  return res.data;
}

async function eventsOf(visitorId, type) {
  const res = await supabase.from('events').select('id, payload').eq('visitor_id', visitorId).eq('type', type);
  if (res.error) throw res.error;
  return res.data ?? [];
}

try {
  // --- migration gate
  const probe = await supabase.from('visitors').select('id').limit(1);
  if (probe.error && isMissingRelation(probe.error)) {
    console.error('❌ Нет таблиц Ф2/Ф3: выполните sql/0003_seller.sql в Supabase SQL Editor.');
    process.exit(1);
  }

  console.log(MANAGE_SERVER ? '── ожидание сервера (npm run start) ──' : `── проверка ${BASE} ──`);
  const up = await waitForServer();
  if (!up) {
    console.error('❌ сервер не поднялся');
    if (MANAGE_SERVER) console.error(serverLog.slice(-1200));
    process.exit(1);
  }
  console.log('  ✓ цель отвечает');

  // --- bot + relaxed nudge timing for the test
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
  console.log(`  ✓ бот «${bot.name}»`);

  originalSettings = bot.settings ?? {};
  const testSettings = {
    ...originalSettings,
    aggressiveness: 70,
    goal: 'phone',
    proactive: {
      enabled: true,
      nudges: { attempts: 2, firstDelaySec: FIRST_DELAY_SEC, intervalSec: INTERVAL_SEC },
      quietHours: { enabled: false, from: '21:00', to: '09:00' },
    },
  };
  const setRes = await supabase.from('bots').update({ settings: testSettings }).eq('id', bot.id);
  if (setRes.error) throw setRes.error;
  console.log(`  ↷ дожим на время теста: ${FIRST_DELAY_SEC}с / ${INTERVAL_SEC}с, цель phone`);

  sessionKey = `nudge-${Date.now()}`;
  visitorKey = `nk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dialog = [];

  // --- 1) fresh answer arms the engine; right away must be too_early
  console.log('── 1. пауза перед первым касанием ──');
  const first = await chat(sessionKey, dialog, 'Здравствуйте! Сколько идёт доставка пуховиков?');
  check('ход 1: ответ получен', first.ok, `HTTP ${first.status}`);

  const early = await nudge(sessionKey);
  check(
    'сразу после ответа — too_early с retryAfterMs',
    early.json?.allowed === false &&
      early.json?.reason === 'too_early' &&
      typeof early.json?.retryAfterMs === 'number' &&
      early.json.retryAfterMs > 0,
    JSON.stringify(early.json),
  );

  // --- 2) after the pause the touch is allowed
  console.log(`── 2. касание после паузы (${FIRST_DELAY_SEC + 2}с) ──`);
  await sleep((FIRST_DELAY_SEC + 2) * 1000);
  const touched = await nudge(sessionKey);
  const nudgeText = typeof touched.json?.text === 'string' ? touched.json.text : '';
  check(
    'касание разрешено: текст + номер',
    touched.json?.allowed === true && nudgeText.length > 10 && touched.json?.nudgeNumber === 1,
    nudgeText.slice(0, 120),
  );

  const conv = await conversationOf(sessionKey);
  check(
    'счётчики беседы: nudges_sent=1, last_nudge_at, stage=followup',
    conv?.nudges_sent === 1 && Boolean(conv?.last_nudge_at) && conv?.stage === 'followup',
    JSON.stringify({ sent: conv?.nudges_sent, stage: conv?.stage }),
  );

  const lastMsg = await supabase
    .from('messages')
    .select('id, role, content, is_proactive, nudge_number')
    .eq('conversation_id', conv?.id)
    .order('id', { ascending: false })
    .limit(1);
  const storedNudge = lastMsg.data?.[0];
  check(
    'касание сохранено как проактивное сообщение',
    storedNudge?.role === 'assistant' && storedNudge?.is_proactive === true && storedNudge?.nudge_number === 1,
    storedNudge ? `id ${storedNudge.id}` : 'нет',
  );

  const visitorRow = await supabase
    .from('visitors')
    .select('id')
    .eq('bot_id', bot.id)
    .eq('visitor_key', visitorKey)
    .maybeSingle();
  const visitorId = visitorRow.data?.id ?? null;
  check('событие nudge_sent записано', (await eventsOf(visitorId, 'nudge_sent')).length >= 1);

  // --- 3) interval guard
  const again = await nudge(sessionKey);
  check(
    'повторное касание сразу — too_early (интервал 60с)',
    again.json?.allowed === false && again.json?.reason === 'too_early',
    JSON.stringify(again.json),
  );

  // --- 4) an answer cancels the pending nudge
  console.log('── 3. ответ посетителя сбрасывает дожим ──');
  const second = await chat(sessionKey, dialog, 'Спасибо! А по срокам как?');
  check('ход 2: ответ получен', second.ok, `HTTP ${second.status}`);
  const convAfter = await conversationOf(sessionKey);
  check(
    'nudges_sent сброшен после ответа посетителя',
    convAfter?.nudges_sent === 0,
    `nudges_sent=${convAfter?.nudges_sent}`,
  );
  check('событие nudge_answered записано', (await eventsOf(visitorId, 'nudge_answered')).length >= 1);

  // --- 5) DND blocks the touch
  console.log('── 4. Do-Not-Disturb ──');
  await supabase.from('visitors').update({ do_not_disturb: true }).eq('id', visitorId);
  const dnd = await nudge(sessionKey);
  check('do_not_disturb → отказ dnd', dnd.json?.allowed === false && dnd.json?.reason === 'dnd', JSON.stringify(dnd.json));
  await supabase.from('visitors').update({ do_not_disturb: false }).eq('id', visitorId);

  // --- 5b) lost dialog: one reactivation touch + revival on a new message
  console.log('── 5б. потерянный диалог: реактивация и оживление ──');
  await supabase.from('conversations').update({ outcome: 'lost' }).eq('id', conv.id);
  await sleep((FIRST_DELAY_SEC + 2) * 1000);
  const react = await nudge(sessionKey);
  check(
    'lost-беседа: одно реактивационное касание разрешено',
    react.json?.allowed === true && react.json?.nudgeNumber === 1,
    typeof react.json?.text === 'string' ? react.json.text.slice(0, 100) : JSON.stringify(react.json),
  );
  const reactAgain = await nudge(sessionKey);
  check(
    'lost-беседа: второй дожим уже закрыт (limit)',
    reactAgain.json?.allowed === false && reactAgain.json?.reason === 'limit',
    JSON.stringify(reactAgain.json),
  );

  const revive = await chat(sessionKey, dialog, 'Ладно, давайте продолжим: что вы посоветуете?');
  check('ход 2б: ответ получен', revive.ok, `HTTP ${revive.status}`);
  const convRevived = await conversationOf(sessionKey);
  check(
    'новое сообщение оживило беседу (outcome → in_progress)',
    convRevived?.outcome === 'in_progress',
    convRevived?.outcome ?? '—',
  );

  // --- 6) stop-words: canned reply + DND + stopped outcome
  console.log('── 5. стоп-слова ──');
  const stop = await chat(sessionKey, dialog, 'Не пишите мне больше, пожалуйста.');
  check('стоп-ответ без LLM', stop.ok && stop.answer.includes('больше не буду писать'), stop.answer.slice(0, 100));
  const visitorAfterStop = await supabase.from('visitors').select('do_not_disturb').eq('id', visitorId).maybeSingle();
  check('после стоп-просьбы включён DND', visitorAfterStop.data?.do_not_disturb === true);
  const convStopped = await conversationOf(sessionKey);
  check('беседа закрыта (outcome=stopped)', convStopped?.outcome === 'stopped', convStopped?.outcome ?? '—');
  check('событие stop_request записано', (await eventsOf(visitorId, 'stop_request')).length >= 1);
  const stoppedNudge = await nudge(sessionKey);
  check(
    'после стоп-просьбы дожим закрыт',
    stoppedNudge.json?.allowed === false && stoppedNudge.json?.reason === 'closed',
    JSON.stringify(stoppedNudge.json),
  );

  // --- 7) quiet hours (fresh dialog, window covering now)
  console.log('── 6. тихие часы ──');
  await supabase.from('visitors').update({ do_not_disturb: false }).eq('id', visitorId);
  sessionKey2 = `nudge-qh-${Date.now()}`;
  const dialog2 = [];
  const warmup = await chat(sessionKey2, dialog2, 'Здравствуйте! Есть ли скидки?');
  check('ход 3: ответ получен', warmup.ok, `HTTP ${warmup.status}`);

  const quietSettings = {
    ...testSettings,
    proactive: {
      ...testSettings.proactive,
      quietHours: { enabled: true, from: '00:00', to: '23:59' },
    },
  };
  const quietRes = await supabase.from('bots').update({ settings: quietSettings }).eq('id', bot.id);
  if (quietRes.error) throw quietRes.error;

  const quiet = await nudge(sessionKey2, 'UTC');
  check(
    'окно тихих часов → отказ quiet_hours + nextAllowedAt',
    quiet.json?.allowed === false &&
      quiet.json?.reason === 'quiet_hours' &&
      typeof quiet.json?.nextAllowedAt === 'string',
    JSON.stringify(quiet.json),
  );
} catch (err) {
  console.error('❌ smoke-nudge упал с ошибкой:', err instanceof Error ? err.message : err);
  failures += 1;
} finally {
  // restore settings
  if (bot) {
    const restore = await supabase
      .from('bots')
      .update({ settings: originalSettings ?? {} })
      .eq('id', bot.id);
    if (restore.error) console.error(`⚠ не удалось восстановить настройки бота: ${restore.error.message}`);
    else console.log('  ↷ настройки бота восстановлены');
  }
  // cleanup test data
  if (bot) {
    try {
      for (const session of [sessionKey, sessionKey2]) {
        if (session) await supabase.from('conversations').delete().eq('bot_id', bot.id).eq('session_key', session);
      }
      if (visitorKey) {
        const v = await supabase.from('visitors').select('id').eq('bot_id', bot.id).eq('visitor_key', visitorKey).maybeSingle();
        const vid = v.data?.id ?? null;
        if (vid) {
          await supabase.from('events').delete().eq('visitor_id', vid);
          await supabase.from('visitors').delete().eq('id', vid);
        }
      }
      console.log('  ↷ тестовые данные очищены');
    } catch {
      console.error('⚠ не удалось полностью очистить тестовые данные');
    }
  }
  stopServer();
}

if (failures > 0) {
  console.error(`\n❌ smoke-nudge: ${failures} проверок провалено`);
  process.exit(1);
}
console.log('\n✅ smoke-nudge: все проверки пройдены');
