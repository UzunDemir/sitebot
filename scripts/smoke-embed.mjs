/**
 * Embed/widget smoke test: loader.js, /embed/<key>, /api/bot?key=,
 * origin-allowlist behavior, feedback endpoint and the quota counter.
 *
 * Uses .env.local (service key) to toggle allowed_origins around the test
 * and to read back counters; restores the original value afterwards.
 *
 * Usage: npm run smoke:embed   (или: node scripts/smoke-embed.mjs <base-url>)
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const BASE = (process.argv[2] ?? 'https://sitebot-nu.vercel.app').replace(/\/+$/, '');

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const s = line.trim();
  if (!s || s.startsWith('#')) continue;
  const i = s.indexOf('=');
  if (i === -1) continue;
  env[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}
const supabase = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY,
);

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '  ✓' : '  ❌'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures += 1;
};

const { data: bots, error: botsError } = await supabase
  .from('bots')
  .select('id, name, public_key, allowed_origins')
  .eq('is_active', true)
  .order('created_at', { ascending: true })
  .limit(1);
if (botsError || !bots || bots.length === 0) {
  console.error('нет активных ботов:', botsError?.message ?? 'пусто');
  process.exit(1);
}
const bot = bots[0];
console.log(`Бот: «${bot.name}», allowed_origins=${JSON.stringify(bot.allowed_origins ?? [])}`);

// 1) loader.js
const loader = await fetch(`${BASE}/loader.js`);
const loaderText = await loader.text();
check('/loader.js → 200', loader.ok, `HTTP ${loader.status}`);
check('loader.js содержит data-bot', loaderText.includes('data-bot'));

// 2) embed page
const embed = await fetch(`${BASE}/embed/${bot.public_key}`);
const embedHtml = await embed.text();
check(`/embed/<key> → 200`, embed.ok, `HTTP ${embed.status}`);
check('embed-страница отдаёт HTML приложения', embedHtml.includes('_next') || /sitebot/i.test(embedHtml));

// 3) /api/bot?key=
const botInfo = await fetch(`${BASE}/api/bot?key=${bot.public_key}`);
const botInfoJson = await botInfo.json().catch(() => null);
check('/api/bot?key → 200', botInfo.ok, `HTTP ${botInfo.status}`);
check('отдаёт именно этого бота', botInfoJson?.bots?.[0]?.publicKey === bot.public_key);

// 3b) unknown key
const missing = await fetch(`${BASE}/api/bot?key=pk_doesnotexist000000000000`);
check('несуществующий ключ → 404', missing.status === 404, `HTTP ${missing.status}`);

// 4) origin allowlist (temporarily restricted, then restored)
const original = bot.allowed_origins ?? [];
try {
  const upd = await supabase
    .from('bots')
    .update({ allowed_origins: ['https://allowed.example'] })
    .eq('id', bot.id);
  if (upd.error) throw upd.error;

  const forbidden = await fetch(`${BASE}/api/bot?key=${bot.public_key}`, {
    headers: { referer: 'https://evil.example/page' },
  });
  const forbiddenJson = await forbidden.json().catch(() => null);
  check(
    'чужой Referer → 403 origin_not_allowed',
    forbidden.status === 403 && forbiddenJson?.error === 'origin_not_allowed',
    `HTTP ${forbidden.status}`,
  );

  const allowed = await fetch(`${BASE}/api/bot?key=${bot.public_key}`, {
    headers: { referer: 'https://allowed.example/landing' },
  });
  check('разрешённый Referer → 200', allowed.ok, `HTTP ${allowed.status}`);

  const noReferer = await fetch(`${BASE}/api/bot?key=${bot.public_key}`);
  check('без Referer → 200 (прямой просмотр)', noReferer.ok, `HTTP ${noReferer.status}`);
} finally {
  await supabase.from('bots').update({ allowed_origins: original }).eq('id', bot.id);
  console.log(`  ↷ allowed_origins восстановлен: ${JSON.stringify(original)}`);
}

// 5) chat → data-feedback → /api/feedback
const chat = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    botKey: bot.public_key,
    sessionKey: `smoke-embed-${Date.now()}`,
    messages: [
      { id: 'e1', role: 'user', parts: [{ type: 'text', text: 'Привет! В одном предложении: что ты умеешь?' }] },
    ],
  }),
});
const raw = await chat.text();
check('/api/chat → 200', chat.ok, `HTTP ${chat.status}`);
const fbIndex = raw.indexOf('data-feedback');
const fbMatch = fbIndex >= 0 ? raw.slice(fbIndex, fbIndex + 200).match(/"messageId":(\d+)/) : null;
check('data-feedback содержит messageId', Boolean(fbMatch));
if (fbMatch) {
  const messageId = Number(fbMatch[1]);
  const fb = await fetch(`${BASE}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messageId, rating: 1 }),
  });
  check('/api/feedback → 200', fb.ok, `HTTP ${fb.status}`);
  const cleanup = await supabase.from('feedback').delete().eq('message_id', messageId);
  check('тестовая оценка удалена', !cleanup.error);
}

// 6) quota counter for today
const today = new Date().toISOString().slice(0, 10);
const quota = await supabase
  .from('quota_counters')
  .select('requests, tokens')
  .eq('bot_id', bot.id)
  .eq('day', today)
  .maybeSingle();
check(
  'quota_counters ведёт учёт за сегодня',
  (quota.data?.requests ?? 0) > 0,
  `requests=${quota.data?.requests ?? 0}, tokens=${quota.data?.tokens ?? '?'}`,
);

if (failures > 0) {
  console.error(`\n❌ smoke-embed: ${failures} проверок провалено`);
  process.exit(1);
}
console.log('\n✅ smoke-embed: все проверки пройдены');
