/**
 * Admin-flow smoke test: login -> upload a document -> ask about it -> delete it.
 *
 * Local mode (default): spawns `npm run start` (requires `npm run build` done
 * and ADMIN_SECRET in .env.local). Remote mode: set SMOKE_BASE_URL.
 *
 * Usage:
 *   node scripts/smoke-admin.mjs
 *   set SMOKE_BASE_URL=https://<домен>
 *   node scripts/smoke-admin.mjs
 */

import { readFileSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const REMOTE_BASE = (process.env.SMOKE_BASE_URL ?? '').trim().replace(/\/+$/, '');
const BASE = REMOTE_BASE || 'http://localhost:3000';
const MANAGE_SERVER = !REMOTE_BASE;

function loadEnvLocal() {
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
    // no .env.local — remote mode still works with a cookie-less check
  }
  return env;
}

const envLocal = loadEnvLocal();
const PASSWORD = envLocal.ADMIN_SECRET ?? '';
if (!PASSWORD) {
  console.error('❌ ADMIN_SECRET не найден в .env.local — нужен для входа в админку.');
  process.exit(1);
}

const STAMP = `LAV-${Date.now().toString(36).toUpperCase()}`;
const DOC_TITLE = `Смоук-документ ${STAMP}`;
const DOC_TEXT = [
  '# Подарочная упаковка',
  '',
  `Фирменная подарочная упаковка магазина «Северный» — лавандового цвета, артикул ${STAMP}.`,
  'Добавить упаковку к заказу можно бесплатно на этапе оформления.',
].join('\n');
const QUESTION = 'Какого цвета фирменная подарочная упаковка и какой у неё артикул?';

const child = MANAGE_SERVER
  ? spawn('cmd.exe', ['/d', '/s', '/c', 'npm run start'], {
      cwd: process.cwd(),
      windowsHide: true,
    })
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
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
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

let cookie = '';
let uploadedDocId = null;
let deleted = false;

try {
  console.log('── ожидание сервера ──');
  const up = await waitForServer();
  if (!up) {
    console.error('❌ цель не отвечает за 40 секунд');
    if (MANAGE_SERVER) console.error(serverLog.slice(-1200));
    process.exit(1);
  }
  console.log('  ✓ цель отвечает');

  // 1) login
  const loginRes = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookies = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
  cookie = cookies.join('; ');
  check('вход в админку', loginRes.ok && cookie.length > 0, `HTTP ${loginRes.status}`);

  // 2) bots list (auth check)
  const botsRes = await fetch(`${BASE}/api/admin/bots`, { headers: { cookie } });
  const botsJson = await botsRes.json().catch(() => null);
  const botId = botsJson?.bots?.[0]?.id;
  check('GET /api/admin/bots под cookie', botsRes.ok, `${botsJson?.bots?.length ?? 0} бот(ов)`);
  if (!botId) throw new Error('в базе нет ни одного бота — сначала npm run seed');

  // 3) upload a fresh document
  const form = new FormData();
  form.append('botId', botId);
  form.append('title', DOC_TITLE);
  form.append('file', new File([DOC_TEXT], 'smoke-admin.md', { type: 'text/markdown' }));
  const upRes = await fetch(`${BASE}/api/admin/documents`, {
    method: 'POST',
    headers: { cookie },
    body: form,
  });
  const upJson = await upRes.json().catch(() => null);
  check(
    'загрузка документа',
    upRes.ok,
    upJson ? `status=${upJson.status}, chunks=${upJson.chunks}` : `HTTP ${upRes.status}`,
  );

  // 4) document appears with status ready
  const listRes = await fetch(`${BASE}/api/admin/documents?botId=${botId}`, { headers: { cookie } });
  const listJson = await listRes.json().catch(() => null);
  const doc = (listJson?.documents ?? []).find((d) => d.title === DOC_TITLE);
  uploadedDocId = doc?.id ?? null;
  check(
    'документ в списке, статус ready',
    Boolean(doc) && doc.status === 'ready',
    doc ? `chunks=${doc.chunk_count}` : 'не найден',
  );

  // 4b) re-index endpoint: unchanged document -> skipped, no re-embedding
  const reRes = await fetch(`${BASE}/api/admin/documents/${doc.id}`, {
    method: 'POST',
    headers: { cookie },
  });
  const reJson = await reRes.json().catch(() => null);
  check(
    'повторная индексация (без изменений → skipped)',
    reRes.ok && reJson?.status === 'skipped',
    reJson ? `status=${reJson.status}` : `HTTP ${reRes.status}`,
  );

  // 5) chat answers from the fresh document
  const chatRes = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionKey: `smoke-admin-${Date.now()}`,
      messages: [
        { id: 'smoke-a1', role: 'user', parts: [{ type: 'text', text: QUESTION }] },
      ],
    }),
  });
  const raw = await chatRes.text();
  check('ответ ссылается на новый документ', raw.includes('лавандов') || raw.includes(STAMP));
  check('/api/chat → 200', chatRes.ok, `HTTP ${chatRes.status}`);

  // 6) delete
  const delRes = await fetch(`${BASE}/api/admin/documents/${doc.id}`, {
    method: 'DELETE',
    headers: { cookie },
  });
  deleted = delRes.ok;
  check('удаление документа', delRes.ok, `HTTP ${delRes.status}`);

  const listRes2 = await fetch(`${BASE}/api/admin/documents?botId=${botId}`, { headers: { cookie } });
  const listJson2 = await listRes2.json().catch(() => null);
  check(
    'документ исчез из списка',
    !(listJson2?.documents ?? []).some((d) => d.title === DOC_TITLE),
  );
} catch (err) {
  console.error('❌ smoke-admin упал с ошибкой:', err instanceof Error ? err.message : err);
  failures += 1;
} finally {
  // best-effort cleanup of the smoke document
  if (uploadedDocId && !deleted && cookie) {
    try {
      await fetch(`${BASE}/api/admin/documents/${uploadedDocId}`, {
        method: 'DELETE',
        headers: { cookie },
      });
      console.log('  ↷ смоук-документ удалён в cleanup-фазе');
    } catch {
      console.log(`  ⚠ смоук-документ остался в базе: ${DOC_TITLE}`);
    }
  }
  stopServer();
}

if (failures > 0) {
  console.error(`\n❌ smoke-admin: ${failures} проверок провалено`);
  process.exit(1);
}
console.log('\n✅ smoke-admin: все проверки пройдены');
