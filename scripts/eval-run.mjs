/**
 * Golden-set eval runner for the RAG bot.
 *
 * Usage:
 *   node scripts/eval-run.mjs [path/to/set.json] [base-url]
 *   npm run eval
 *
 * Set format:
 * {
 *   "name": "...",
 *   "botKey": "pk_...",
 *   "cases": [
 *     { "q": "...", "expect": ["5000"], "source": "Доставка" },
 *     { "q": "...", "expectAny": ["нельзя", "невозможен"] },
 *     { "q": "...", "refusal": true }
 *   ]
 * }
 *
 * Checks: distinctive facts (normalized compare), cited source titles,
 * and honest refusals/negations for out-of-KB questions.
 * Exit code 1 on any failure.
 */

import { readFileSync } from 'node:fs';

const setPath = process.argv[2] ?? 'evals/demo-shop.json';
const BASE = (
  process.argv[3] ??
  process.env.EVAL_BASE_URL ??
  'https://sitebot-nu.vercel.app'
).replace(/\/+$/, '');

const spec = JSON.parse(readFileSync(setPath, 'utf8'));
const cases = Array.isArray(spec.cases) ? spec.cases : [];
if (!spec.botKey || cases.length === 0) {
  console.error('❌ В файле нет botKey или cases');
  process.exit(1);
}

const REFUSAL =
  /не (располагаю|знаю|могу ответить|имею|наш[её]л|могу подтвердить)|нет[, ]+(информации|данных)|информации[^.!?]{0,60}нет|у меня нет|не могу (ответить|помочь|предоставить)|не удалось найти|обратитесь|свяжитесь|поддержк|уточните/i;
const NEGATION = /нельзя|невозможн|не принима|не доставля|не поддержива|отсутству/i;

function norm(text) {
  return String(text)
    .toLowerCase()
    .replace(/\u00a0/g, '')
    .replace(/[–—]/g, '-')
    .replace(/[«»"']/g, '')
    .replace(/\s+/g, '');
}

function extractField(raw, field) {
  const pattern = new RegExp(`"${field}":"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  return [...raw.matchAll(pattern)].map((m) => m[1]);
}

function extractSources(raw) {
  const idx = raw.indexOf('"type":"data-sources"');
  if (idx < 0) return [];
  const seg = raw.slice(idx, idx + 4000);
  return [...seg.matchAll(/"title":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
}

console.log(`Набор: «${spec.name ?? setPath}» · кейсов: ${cases.length} · база: ${BASE}\n`);

let passed = 0;
const failures = [];

for (let i = 0; i < cases.length; i += 1) {
  const c = cases[i];
  const question = String(c.q ?? '');
  let answer = '';
  let sources = [];
  let httpOk = false;

  try {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        botKey: spec.botKey,
        sessionKey: `eval-${Date.now()}-${i}`,
        messages: [{ id: `eval-${i}`, role: 'user', parts: [{ type: 'text', text: question }] }],
      }),
    });
    httpOk = res.ok;
    const raw = await res.text();
    answer = [...extractField(raw, 'text'), ...extractField(raw, 'delta')]
      .join('')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"');
    sources = extractSources(raw);
  } catch (err) {
    failures.push({ question, reason: `сеть: ${err.message}` });
    console.log(`  ❌ [${i + 1}] ${question} — сетевая ошибка`);
    continue;
  }

  const problems = [];
  const na = norm(answer);

  if (!httpOk) problems.push('HTTP не 200');
  if (c.refusal) {
    if (!REFUSAL.test(answer) && !NEGATION.test(answer)) {
      problems.push('ожидался честный отказ/отрицание, бот ответил фактами');
    }
  } else {
    for (const item of c.expect ?? []) {
      if (!na.includes(norm(item))) problems.push(`нет «${item}»`);
    }
    if (Array.isArray(c.expectAny) && c.expectAny.length > 0) {
      const ok = c.expectAny.some((item) => na.includes(norm(item)));
      if (!ok) problems.push(`нет ни одного из: ${c.expectAny.join(' | ')}`);
    }
    if (c.source) {
      const ok = sources.some((title) =>
        String(title).toLowerCase().includes(String(c.source).toLowerCase()),
      );
      if (!ok) {
        problems.push(`источник «${c.source}» не процитирован (${sources.join(', ') || 'нет источников'})`);
      }
    }
  }

  if (problems.length === 0) {
    passed += 1;
    console.log(`  ✓ [${i + 1}] ${question}`);
  } else {
    failures.push({ question, reason: problems.join('; ') });
    console.log(`  ❌ [${i + 1}] ${question} — ${problems.join('; ')}`);
    console.log(`      ответ: ${answer.replace(/\s+/g, ' ').slice(0, 220)}`);
  }
}

const score = Math.round((passed / cases.length) * 100);
console.log(`\nИтог «${spec.name ?? setPath}»: ${passed}/${cases.length} (${score}%)`);
if (failures.length > 0) {
  console.log('Провалы:');
  for (const f of failures) console.log(`  - ${f.question}: ${f.reason}`);
  process.exit(1);
}
console.log('✅ Все кейсы прошли');
