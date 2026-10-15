/**
 * Visitor card acceptance test (Ф2): extraction -> card -> admin API -> forget.
 *
 * Local mode (default): spawns `npm run start` (run `npm run build` first).
 * Remote mode: set SMOKE_BASE_URL.
 *
 * Requires sql/0003_seller.sql applied and .env.local (service key + admin
 * password) for verification and cleanup.
 *
 * Checks:
 *   1. chat with visitorKey -> the card gets the name, phone, birthday and
 *      preferences (LLM extraction, sql/0004 fields)
 *   2. the conversation is linked to the visitor
 *   3. POST /api/events stores session_start; an unknown type is rejected
 *   4. GET /api/chat/history returns { visitor: { name, returning } }
 *   5. admin API: the list contains the card; PATCH saves notes/tags/birthday/
 *      preferences; purchases can be added and deleted; the detail returns
 *      all of it with conversations and events
 *   6. POST /api/chat/forget opens a memory epoch (no deletion; see smoke:reset)
 *
 * Requires sql/0003_seller.sql and sql/0004_card.sql.
 *
 * Usage: npm run smoke:visitor
 */

import { readFileSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from '@supabase/supabase-js';

const REMOTE_BASE = (process.env.SMOKE_BASE_URL ?? '').trim().replace(/\/+$/, '');
const BASE = REMOTE_BASE || 'http://localhost:3000';
const MANAGE_SERVER = !REMOTE_BASE;

// --- .env.local (service key + admin password)
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
  console.error('❌ .env.local не найден — нужен сервисный ключ и ADMIN_SECRET.');
  process.exit(1);
}
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY);
const ADMIN_SECRET = env.ADMIN_SECRET ?? '';

function isMissingRelation(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === '42P01' || err.code === 'PGRST205') return true;
  return (
    typeof err.message === 'string' &&
    /relation .* does not exist|could not find the table|schema cache/i.test(err.message)
  );
}

const NAME = 'Игорь';
const PHONE_LINE = 'мой телефон 8-800-555-35-35';
const BIRTHDAY_LINE = 'у меня день рождения 5 марта';
const FIRST_MESSAGE = `Здравствуйте! Меня зовут ${NAME}, ${PHONE_LINE}, ${BIRTHDAY_LINE}. Интересует доставка пуховиков, люблю оверсайз.`;

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

function digitsOf(value) {
  return String(value ?? '').replace(/\D/g, '');
}

let bot = null;
let sessionKey = '';
let visitorKey = '';
let cardId = null;
let cookie = '';

try {
  // --- migration gate
  const probe = await supabase.from('visitors').select('id').limit(1);
  if (probe.error) {
    if (isMissingRelation(probe.error)) {
      console.error('❌ Таблицы посетителей нет: выполните sql/0003_seller.sql в Supabase SQL Editor.');
      process.exit(1);
    }
    throw probe.error;
  }
  const probePurchases = await supabase.from('purchases').select('id').limit(1);
  if (probePurchases.error && isMissingRelation(probePurchases.error)) {
    console.error('❌ Таблицы purchases нет: выполните sql/0004_card.sql в Supabase SQL Editor.');
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

  // --- bot
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
  console.log(`  ✓ бот «${bot.name}»`);

  sessionKey = `visitor-${Date.now()}`;
  visitorKey = `vk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // --- 1) chat with the visitor key -> extraction fills the card
  console.log('── /api/chat: посетитель представляется ──');
  const chatRes = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      botKey: bot.public_key,
      sessionKey,
      visitorKey,
      messages: [{ id: 'v-user-1', role: 'user', parts: [{ type: 'text', text: FIRST_MESSAGE }] }],
    }),
  });
  const raw = await chatRes.text();
  check('/api/chat → 200', chatRes.ok, `HTTP ${chatRes.status}`);
  check('ответ содержит текст', /[А-Яа-я]/.test(raw));

  // Extraction runs after the response — poll the card for up to 40 s.
  let card = null;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    await sleep(2000);
    const cardRes = await supabase
      .from('visitors')
      .select(
        'id, name, contacts, memory_digest, first_seen, last_seen, birthday_day, birthday_month, birthday_year, preferences, complaints',
      )
      .eq('bot_id', bot.id)
      .eq('visitor_key', visitorKey)
      .maybeSingle();
    if (cardRes.error) throw cardRes.error;
    card = cardRes.data;
    if (card && card.name && digitsOf(card.contacts?.phone).length >= 7 && card.birthday_month === 3) break;
  }
  cardId = card?.id ?? null;
  check('карточка создана', Boolean(card), card ? `id ${card.id}` : 'нет');
  check(
    'имя извлечено из диалога',
    Boolean(card?.name) && String(card.name).toLowerCase().includes(NAME.toLowerCase()),
    card?.name ?? '—',
  );
  check('телефон извлечён в контакты', digitsOf(card?.contacts?.phone).length >= 7, card?.contacts?.phone ?? '—');
  check(
    'дата рождения извлечена (5 марта)',
    card?.birthday_day === 5 && card?.birthday_month === 3,
    card ? `${card.birthday_day}.${card.birthday_month}` : '—',
  );
  check(
    'предпочтения извлечены',
    (card?.preferences ?? []).length >= 1,
    JSON.stringify(card?.preferences ?? []),
  );

  // --- 2) the conversation is linked to the visitor
  const convRes = await supabase
    .from('conversations')
    .select('id, visitor_id')
    .eq('bot_id', bot.id)
    .eq('session_key', sessionKey)
    .maybeSingle();
  if (convRes.error) throw convRes.error;
  check(
    'беседа привязана к карточке',
    Boolean(convRes.data) && convRes.data.visitor_id === cardId,
    convRes.data ? `visitor_id=${convRes.data.visitor_id ? 'да' : 'нет'}` : 'беседы нет',
  );

  // --- 3) events
  console.log('── /api/events ──');
  const eventRes = await fetch(`${BASE}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ botKey: bot.public_key, sessionKey, visitorKey, type: 'session_start' }),
  });
  const eventJson = await eventRes.json().catch(() => null);
  check('session_start принят', eventRes.ok && eventJson?.stored === true, `HTTP ${eventRes.status}`);
  const badEventRes = await fetch(`${BASE}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ botKey: bot.public_key, visitorKey, type: 'взлом' }),
  });
  check('неизвестный тип события отклонён', badEventRes.status === 400, `HTTP ${badEventRes.status}`);
  const storedEvents = await supabase
    .from('events')
    .select('id')
    .eq('visitor_id', cardId)
    .eq('type', 'session_start');
  check('событие сохранено в БД', (storedEvents.data ?? []).length >= 1, `строк: ${(storedEvents.data ?? []).length}`);

  // --- 4) history returns the visitor hint
  const historyRes = await fetch(
    `${BASE}/api/chat/history?botKey=${encodeURIComponent(bot.public_key)}&sessionKey=${encodeURIComponent(sessionKey)}&visitorKey=${encodeURIComponent(visitorKey)}`,
  );
  const historyJson = await historyRes.json().catch(() => null);
  check('/api/chat/history → 200', historyRes.ok, `HTTP ${historyRes.status}`);
  check(
    'история отдаёт visitor.returning + имя',
    historyJson?.visitor?.returning === true &&
      typeof historyJson?.visitor?.name === 'string' &&
      historyJson.visitor.name.toLowerCase().includes(NAME.toLowerCase()),
    JSON.stringify(historyJson?.visitor ?? null),
  );

  // --- 5) admin API
  console.log('── админ-карточка ──');
  if (!ADMIN_SECRET) throw new Error('нет ADMIN_SECRET в .env.local');
  const loginRes = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_SECRET }),
  });
  const cookies = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
  cookie = cookies.join('; ');
  check('вход в админку', loginRes.ok && cookie.length > 0, `HTTP ${loginRes.status}`);

  const listRes = await fetch(`${BASE}/api/admin/visitors?botId=${bot.id}`, { headers: { cookie } });
  const listJson = await listRes.json().catch(() => null);
  const listed = (listJson?.visitors ?? []).find((v) => v.id === cardId);
  check('карточка видна в списке админки', listRes.ok && Boolean(listed), listed?.name ?? `HTTP ${listRes.status}`);

  const noteText = 'Смоук: договорились созвониться в четверг';
  const patchRes = await fetch(`${BASE}/api/admin/visitors/${cardId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      notes: noteText,
      tags: 'смоук, проверка',
      birthday: '01.12',
      preferences: ['любит смоук-тесты'],
    }),
  });
  const patchJson = await patchRes.json().catch(() => null);
  check(
    'заметка, теги, ДР и предпочтения сохраняются',
    patchRes.ok &&
      patchJson?.visitor?.notes === noteText &&
      (patchJson?.visitor?.tags ?? []).length === 2 &&
      patchJson?.visitor?.birthday === '01.12' &&
      (patchJson?.visitor?.preferences ?? []).includes('любит смоук-тесты'),
    patchJson?.visitor ? `birthday=${patchJson.visitor.birthday}` : `HTTP ${patchRes.status}`,
  );

  const detailRes = await fetch(`${BASE}/api/admin/visitors/${cardId}`, { headers: { cookie } });
  const detailJson = await detailRes.json().catch(() => null);
  check(
    'карточка в админке: заметки, беседы, события',
    detailRes.ok &&
      detailJson?.visitor?.notes === noteText &&
      detailJson?.purchasesAvailable === true &&
      (detailJson?.conversations ?? []).length >= 1 &&
      (detailJson?.events ?? []).length >= 1,
    `бесед: ${(detailJson?.conversations ?? []).length}, событий: ${(detailJson?.events ?? []).length}`,
  );

  // --- 5b) purchases (sql/0004): add via admin API, see in the card, delete
  const buyRes = await fetch(`${BASE}/api/admin/purchases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ visitorId: cardId, title: 'Смоук-пуховик', amount: 1234, status: 'completed' }),
  });
  const buyJson = await buyRes.json().catch(() => null);
  const buyId = buyJson?.purchase?.id ?? '';
  check(
    'покупка добавлена',
    buyRes.ok && buyJson?.purchase?.title === 'Смоук-пуховик' && buyJson?.purchase?.amount === 1234,
    `HTTP ${buyRes.status}`,
  );
  const afterBuy = await fetch(`${BASE}/api/admin/visitors/${cardId}`, { headers: { cookie } });
  const afterBuyJson = await afterBuy.json().catch(() => null);
  check(
    'покупка видна в карточке',
    (afterBuyJson?.purchases ?? []).some((purchase) => purchase.id === buyId && purchase.title === 'Смоук-пуховик'),
    `покупок: ${(afterBuyJson?.purchases ?? []).length}`,
  );
  if (buyId) {
    const delBuy = await fetch(`${BASE}/api/admin/purchases/${encodeURIComponent(buyId)}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    const delJson = await delBuy.json().catch(() => null);
    check('покупка удалена', delBuy.ok && delJson?.ok === true, `HTTP ${delBuy.status}`);
  }
  // вторая покупка остаётся — проверяем, что «забыть меня» её не трогает
  const buy2 = await fetch(`${BASE}/api/admin/purchases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ visitorId: cardId, title: 'Смоук-возврат', amount: 10, status: 'refunded' }),
  });
  const buy2Json = await buy2.json().catch(() => null);
  check(
    'вторая покупка добавлена (для каскада)',
    buy2.ok && Boolean(buy2Json?.purchase?.id),
    `HTTP ${buy2.status}`,
  );

  // --- 6) forget me → новая эпоха памяти (память не удаляется)
  console.log('── /api/chat/forget (эпоха) ──');
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

  const kept = await supabase.from('visitors').select('id, name, memory_digest').eq('id', cardId).maybeSingle();
  check('карточка сохранена (память не удаляется)', Boolean(kept.data?.id), kept.data ? '' : 'карточка исчезла');
  check(
    'активная память обнулена',
    !kept.data?.name && !(kept.data?.memory_digest ?? ''),
    `name=${kept.data?.name ?? 'null'}`,
  );
  const epoch = await supabase.from('memory_resets').select('id, source').eq('visitor_id', cardId);
  check('эпоха записана (memory_resets)', (epoch.data ?? []).length === 1, `rows=${(epoch.data ?? []).length}`);
  const keptConv = await supabase
    .from('conversations')
    .select('outcome')
    .eq('bot_id', bot.id)
    .eq('session_key', sessionKey)
    .maybeSingle();
  check('беседа закрыта (memory_reset)', keptConv.data?.outcome === 'memory_reset', `outcome=${keptConv.data?.outcome}`);
  const keptPurchases = await supabase.from('purchases').select('id').eq('visitor_id', cardId);
  check('покупки сохранены', (keptPurchases.data ?? []).length > 0, `rows=${(keptPurchases.data ?? []).length}`);
} catch (err) {
  console.error('❌ smoke-visitor упал с ошибкой:', err instanceof Error ? err.message : err);
  failures += 1;
} finally {
  // best-effort cleanup of any leftovers
  if (bot && (sessionKey || visitorKey)) {
    try {
      if (sessionKey) await supabase.from('conversations').delete().eq('bot_id', bot.id).eq('session_key', sessionKey);
      if (cardId) {
        await supabase.from('events').delete().eq('visitor_id', cardId);
        await supabase.from('visitors').delete().eq('id', cardId);
      }
      if (visitorKey) await supabase.from('visitors').delete().eq('bot_id', bot.id).eq('visitor_key', visitorKey);
      console.log('  ↷ тестовые данные очищены');
    } catch {
      console.error('⚠ не удалось полностью очистить тестовые данные');
    }
  }
  stopServer();
}

if (failures > 0) {
  console.error(`\n❌ smoke-visitor: ${failures} проверок провалено`);
  process.exit(1);
}
console.log('\n✅ smoke-visitor: все проверки пройдены');
