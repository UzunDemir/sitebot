/**
 * End-to-end smoke test for the chat bot.
 *
 * Local mode (default): spawns `npm run start` on port 3000, waits for
 * readiness, runs the checks, then stops the process tree.
 * Remote mode: set SMOKE_BASE_URL (e.g. the Vercel production URL) to test
 * an already-running deployment — no server is spawned.
 *
 * Checks:
 *   1. GET  /api/bot   — bot must be seeded
 *   2. POST /api/chat  — one real question; streamed answer + sources part
 *
 * Usage:
 *   npm run smoke:e2e                            (local, after build+seed)
 *   set SMOKE_BASE_URL=https://example.com
 *   npm run smoke:e2e                            (remote)
 */

import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const REMOTE_BASE = (process.env.SMOKE_BASE_URL ?? '').trim().replace(/\/+$/, '');
const BASE = REMOTE_BASE || 'http://localhost:3000';
const MANAGE_SERVER = !REMOTE_BASE;
const QUESTION = 'Сколько идёт возврат денег?';

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
      if (res.status > 0) return true; // any HTTP answer means the target is up
    } catch {
      // not up yet
    }
  }
  return false;
}

function extractStreamField(raw, field) {
  const pattern = new RegExp(`"${field}":"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  return [...raw.matchAll(pattern)].map((m) => m[1]);
}

let up = false;
try {
  console.log(
    MANAGE_SERVER
      ? '── ожидание сервера (npm run start) ──'
      : `── проверка развёрнутого адреса: ${BASE} ──`,
  );
  up = await waitForServer();

  if (!up) {
    console.error(
      MANAGE_SERVER
        ? '❌ Сервер не поднялся за 40 секунд. Хвост лога:'
        : `❌ ${BASE} не отвечает за 40 секунд`,
    );
    if (MANAGE_SERVER) console.error(serverLog.slice(-1500));
    failures += 1;
  } else {
    console.log('  ✓ цель отвечает');

    // 1) bot endpoint
    const botRes = await fetch(`${BASE}/api/bot`);
    const botJson = await botRes.json().catch(() => null);
    check(
      '/api/bot → 200',
      botRes.ok,
      botJson?.name ? `бот: ${botJson.name}` : `HTTP ${botRes.status}`,
    );
    check('/api/bot: есть publicKey', Boolean(botJson?.publicKey));

    // 2) chat endpoint
    console.log('── /api/chat: реальный вопрос ──');
    const chatRes = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionKey: `e2e-${Date.now()}`,
        messages: [
          {
            id: 'e2e-user-1',
            role: 'user',
            parts: [{ type: 'text', text: QUESTION }],
          },
        ],
      }),
    });
    check('/api/chat → 200', chatRes.ok, `HTTP ${chatRes.status}`);

    const raw = await chatRes.text();
    check('ответ непустой', raw.length > 0, `${raw.length} симв.`);
    check('есть data-sources (источники)', raw.includes('data-sources'));
    check('есть текст ответа', /[А-Яа-я]/.test(raw));

    const answer = [...extractStreamField(raw, 'text'), ...extractStreamField(raw, 'delta')]
      .join('')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"');
    if (answer) {
      console.log('── фрагмент ответа ──');
      console.log(answer.slice(0, 400));
    } else {
      console.log('── сырой хвост стрима (первые 400 симв.) ──');
      console.log(raw.slice(0, 400));
    }
  }
} catch (err) {
  console.error('❌ smoke-e2e упал с ошибкой:', err instanceof Error ? err.message : err);
  failures += 1;
} finally {
  stopServer();
}

if (failures > 0) {
  console.error(`\n❌ smoke-e2e: ${failures} проверок провалено`);
  process.exit(1);
}
console.log('\n✅ smoke-e2e: все проверки пройдены');
