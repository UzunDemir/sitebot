/**
 * Local smoke test — no network, no API keys required.
 *
 * Validates:
 *   1. tsx can execute the lib import graph (the same way seed.ts will)
 *   2. chunker behavior on the demo knowledge base (counts, sizes)
 *   3. pgvector literal serialization
 *
 * Usage: npx tsx scripts/smoke-local.ts
 */

import { chunkDocument } from '../lib/chunker';
import { toVectorLiteral } from '../lib/embeddings';
import { getSupabase } from '../lib/supabase';
import {
  LEGACY_SESSION_KEY,
  makeSessionId,
  readSessionKey,
  readVisitorKey,
  sessionStorageKey,
  visitorStorageKey,
} from '../lib/session-key';
import {
  factsAreEmpty,
  mergeVisitorFacts,
  sanitizeStrategistResult,
  sanitizeVisitorFacts,
} from '../lib/visitor-memory';
import {
  BOT_SETTINGS_DEFAULTS,
  effectiveAggressiveness,
  effectiveProactive,
  parseBotSettings,
} from '../lib/bot-settings';
import {
  inQuietWindow,
  isStopRequest,
  minutesOf,
  nudgeFallbackText,
  quietHoursEnd,
  sanitizeNudgeText,
} from '../lib/nudge';
import { DEMO_KB } from './demo-kb';

void getSupabase; // import-graph check only; not called (needs env)

/** Minimal in-memory Storage for the session-key tests. */
function fakeStorage(init: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(init));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    dump: () => Object.fromEntries(map),
  };
}

function main(): void {
  let failures = 0;

  // --- 1. chunker over the demo KB
  console.log('── chunker over demo KB ──');
  let totalChunks = 0;
  for (const doc of DEMO_KB) {
    const chunks = chunkDocument(doc.content);
    if (chunks.length === 0) {
      console.error(`❌ «${doc.title}»: 0 чанков`);
      failures += 1;
      continue;
    }
    const sizes = chunks.map((c) => c.content.length);
    const max = Math.max(...sizes);
    const min = Math.min(...sizes);
    const avg = Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
    if (max > 2400) {
      console.error(`❌ «${doc.title}»: чанк ${max} символов > hard cap 2400`);
      failures += 1;
    }
    const idxOk = chunks.every((c, i) => c.idx === i);
    if (!idxOk) {
      console.error(`❌ «${doc.title}»: нарушена нумерация idx`);
      failures += 1;
    }
    totalChunks += chunks.length;
    console.log(`  ✓ ${doc.title}: ${chunks.length} чанк(ов), min=${min}, avg=${avg}, max=${max}`);
  }
  console.log(`  всего чанков: ${totalChunks}`);

  // --- 2. pgvector literal
  console.log('── pgvector literal ──');
  const literal = toVectorLiteral([0.1, -2, 3]);
  if (literal !== '[0.1,-2,3]') {
    console.error(`❌ toVectorLiteral вернул: ${literal}`);
    failures += 1;
  } else {
    console.log(`  ✓ toVectorLiteral: ${literal}`);
  }

  // --- 3. env guard: missing env must throw a clear error (not a cryptic one)
  console.log('── env guard ──');
  try {
    getSupabase();
    console.log('  (env присутствует — getSupabase() инициализирован)');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Missing required environment variable')) {
      console.log(`  ✓ понятная ошибка без env: ${message.slice(0, 60)}…`);
    } else {
      console.error(`❌ неожиданная ошибка: ${message}`);
      failures += 1;
    }
  }

  // --- 4. session key: per-bot isolation + legacy migration
  console.log('── session key ──');
  {
    // fresh visitor: a key is created and stays stable
    const s1 = fakeStorage();
    const first = readSessionKey(s1, 'pk_a');
    const again = readSessionKey(s1, 'pk_a');
    if (first && first === again && s1.getItem(sessionStorageKey('pk_a')) === first) {
      console.log('  ✓ новый ключ создаётся и стабилен');
    } else {
      console.error(`❌ ключ нестабилен: ${first} / ${again}`);
      failures += 1;
    }

    // per-bot isolation: two bots on one device → two keys
    const second = readSessionKey(s1, 'pk_b');
    if (second && second !== first) {
      console.log('  ✓ у двух ботов — разные ключи');
    } else {
      console.error(`❌ ключи ботов совпали: ${second}`);
      failures += 1;
    }

    // legacy migration: the old shared key is adopted once
    const legacy = readSessionKey(fakeStorage({ [LEGACY_SESSION_KEY]: 'legacy-1' }), 'pk_c');
    if (legacy === 'legacy-1') {
      console.log('  ✓ legacy-ключ переносится в per-bot ключ');
    } else {
      console.error(`❌ legacy-ключ не мигрирован: ${legacy}`);
      failures += 1;
    }

    // id generator: unique, non-empty
    const ids = new Set([makeSessionId(), makeSessionId(), makeSessionId()]);
    if (ids.size === 3 && [...ids].every((id) => id.length > 0)) {
      console.log('  ✓ генератор id: 3 уникальных значения');
    } else {
      console.error('❌ генератор id вернул дубликаты');
      failures += 1;
    }
  }

  // --- 5. visitor card: keys + pure fact helpers
  console.log('── visitor card ──');
  {
    // visitor key: stable per bot, isolated between bots
    const store = fakeStorage();
    const vk1 = readVisitorKey(store, 'pk_a');
    const vk2 = readVisitorKey(store, 'pk_a');
    const vkOther = readVisitorKey(store, 'pk_b');
    if (vk1 && vk1 === vk2 && vk1 !== vkOther && store.getItem(visitorStorageKey('pk_a')) === vk1) {
      console.log('  ✓ visitor-ключ стабилен и изолирован по ботам');
    } else {
      console.error(`❌ visitor-ключ: ${vk1} / ${vk2} / ${vkOther}`);
      failures += 1;
    }

    // sanitize: trims values, caps lists, drops junk keys and types
    const sanitized = sanitizeVisitorFacts({
      name: '  Игорь  ',
      contacts: { phone: ' +7 900 000-00-00 ', spam: 'x', telegram: 42, email: 'a@b.ru' },
      interests: ['доставка', 'доставка', '', 7, 'оплата', 'гарантия', 'бонусы'],
      note: '  Просил перезвонить в четверг  ',
    });
    const contacts = sanitized.contacts ?? {};
    if (
      sanitized.name === 'Игорь' &&
      contacts.phone === '+7 900 000-00-00' &&
      contacts.email === 'a@b.ru' &&
      !('spam' in contacts) &&
      !('telegram' in contacts) &&
      JSON.stringify(sanitized.interests) === JSON.stringify(['доставка', 'оплата', 'гарантия']) &&
      sanitized.note === 'Просил перезвонить в четверг'
    ) {
      console.log('  ✓ sanitizeVisitorFacts: мусор отброшен, значения нормализованы');
    } else {
      console.error(`❌ sanitizeVisitorFacts: ${JSON.stringify(sanitized)}`);
      failures += 1;
    }

    // junk input → empty facts
    if (factsAreEmpty(sanitizeVisitorFacts('мусор')) && factsAreEmpty(sanitizeVisitorFacts(null))) {
      console.log('  ✓ мусорный вход → пустые факты');
    } else {
      console.error('❌ мусорный вход не отфильтрован');
      failures += 1;
    }

    // merge: existing (owner) values win, interests union, digest append-once
    const merged = mergeVisitorFacts(
      {
        name: 'Мария',
        contacts: { phone: '+7 111' },
        meta: { interests: ['обувь'] },
        memory_digest: 'Старый факт',
      },
      {
        name: 'Игорь',
        contacts: { phone: '+7 999', email: 'a@b.ru' },
        interests: ['доставка'],
        note: 'Новый факт',
      },
    );
    if (
      merged.name === 'Мария' &&
      merged.contacts.phone === '+7 111' &&
      merged.contacts.email === 'a@b.ru' &&
      JSON.stringify(merged.meta.interests) === JSON.stringify(['обувь', 'доставка']) &&
      merged.memory_digest === 'Старый факт\nНовый факт'
    ) {
      console.log('  ✓ mergeVisitorFacts: имя/контакты владельца не перезаписаны');
    } else {
      console.error(`❌ mergeVisitorFacts: ${JSON.stringify(merged)}`);
      failures += 1;
    }

    const mergedAgain = mergeVisitorFacts(
      { name: null, contacts: {}, meta: {}, memory_digest: 'Новый факт' },
      { note: 'Новый факт' },
    );
    if (mergedAgain.memory_digest === 'Новый факт') {
      console.log('  ✓ повторный факт не дублируется в дайджесте');
    } else {
      console.error(`❌ дайджест продублирован: ${mergedAgain.memory_digest}`);
      failures += 1;
    }
  }

  // --- 6. Ф3: стоп-слова, тихие часы, дожим, стратег, настройки
  console.log('── nudge / strategist ──');
  {
    // stop words: caught phrases vs ordinary questions
    const stops = [
      'Не пишите мне больше',
      'пожалуйста, стоп',
      'Stop!',
      'отстаньте от меня',
      'прекратите писать',
    ];
    const notStops = ['Расскажите про доставку', 'Что такое возврат?', 'А есть скидки?'];
    if (stops.every((t) => isStopRequest(t)) && notStops.every((t) => !isStopRequest(t))) {
      console.log('  ✓ isStopRequest: стоп-фразы пойманы, обычные вопросы — нет');
    } else {
      console.error(
        `❌ isStopRequest: ${[...stops, ...notStops].map((t) => `${t}=${isStopRequest(t)}`).join(', ')}`,
      );
      failures += 1;
    }

    // quiet hours: HH:MM math + the midnight wrap
    const quietOk =
      minutesOf('21:00') === 1260 &&
      minutesOf('9:30') === 570 &&
      minutesOf('25:00') === null &&
      minutesOf('21:70') === null &&
      inQuietWindow(22 * 60 + 30, 1260, 540) === true &&
      inQuietWindow(8 * 60, 1260, 540) === true &&
      inQuietWindow(10 * 60, 1260, 540) === false &&
      inQuietWindow(13 * 60, 780, 840) === true &&
      inQuietWindow(15 * 60, 780, 840) === false;
    if (quietOk) {
      console.log('  ✓ тихие часы: окно и переход через полночь считаются верно');
    } else {
      console.error('❌ тихие часы: арифметика окна сломана');
      failures += 1;
    }

    const end = quietHoursEnd(new Date('2026-01-15T22:30:00Z'), 'UTC', 540);
    if (end && end.toISOString() === '2026-01-16T09:00:00.000Z') {
      console.log('  ✓ quietHoursEnd: конец окна — завтра в 09:00 UTC');
    } else {
      console.error(`❌ quietHoursEnd: ${end ? end.toISOString() : 'null'}`);
      failures += 1;
    }

    // nudge text sanitizing + canned fallbacks
    const textOk =
      sanitizeNudgeText('  «Ещё раз здравствуйте!»  ') === 'Ещё раз здравствуйте!' &&
      sanitizeNudgeText('   ') === null &&
      sanitizeNudgeText(42) === null &&
      sanitizeNudgeText(`x`.repeat(900))?.length === 500;
    const fallbacks = [nudgeFallbackText(1), nudgeFallbackText(2), nudgeFallbackText(4)];
    if (textOk && fallbacks.every((t) => t.length > 0) && new Set(fallbacks).size === 3) {
      console.log('  ✓ sanitizeNudgeText / nudgeFallbackText в порядке');
    } else {
      console.error(`❌ nudge text helpers: ${JSON.stringify(fallbacks)}`);
      failures += 1;
    }

    // strategist output: stage + goal_progress + facts
    const strat = sanitizeStrategistResult({
      stage: 'offer',
      goal_progress: 'achieved',
      name: 'Игорь',
      contacts: { phone: '+7 900 000-00-00' },
      interests: ['пуховики'],
      note: 'Ждёт звонка',
    });
    const stratJunk = sanitizeStrategistResult({ stage: 'какая-то', goal_progress: 'чуток' });
    if (
      strat.stage === 'offer' &&
      strat.goalProgress === 'achieved' &&
      strat.facts.name === 'Игорь' &&
      strat.facts.contacts?.phone === '+7 900 000-00-00' &&
      strat.facts.note === 'Ждёт звонка' &&
      stratJunk.stage === undefined &&
      stratJunk.goalProgress === undefined
    ) {
      console.log('  ✓ стратег: стадия и прогресс цели разобраны, мусор отброшен');
    } else {
      console.error(`❌ стратег: ${JSON.stringify({ strat, stratJunk })}`);
      failures += 1;
    }

    // settings: aggressiveness scale + legacy mapping + proactive parsing
    const parsed = parseBotSettings({
      aggressiveness: 65,
      tone: 80,
      goal: 'messenger',
      proactive: {
        enabled: true,
        nudges: { attempts: 3, firstDelaySec: 30, intervalSec: 120 },
        quietHours: { enabled: true, from: '21:00', to: '09:00' },
      },
    });
    const proactive = effectiveProactive(parsed);
    const legacy = parseBotSettings({ salesPressure: 2 });
    if (
      parsed.aggressiveness === 65 &&
      parsed.tone === 80 &&
      parsed.goal === 'messenger' &&
      proactive.enabled === true &&
      proactive.attempts === 3 &&
      proactive.firstDelaySec === 30 &&
      proactive.intervalSec === 120 &&
      proactive.quietHours.from === '21:00' &&
      effectiveAggressiveness(parsed) === 65 &&
      effectiveAggressiveness(legacy) === 80 &&
      effectiveAggressiveness({}) === BOT_SETTINGS_DEFAULTS.aggressiveness &&
      effectiveAggressiveness({ aggressiveness: 15, salesPressure: 2 }) === 15 &&
      parseBotSettings({ aggressiveness: 250 }).aggressiveness === 100 &&
      parseBotSettings({ goal: 'несуществующая' }).goal === undefined &&
      effectiveProactive({}).attempts === BOT_SETTINGS_DEFAULTS.proactive.nudges.attempts
    ) {
      console.log('  ✓ настройки: агрессивность (в т.ч. legacy), цели, дожим разобраны');
    } else {
      console.error(
        `❌ настройки: ${JSON.stringify({ parsed, proactive, legacyAgg: effectiveAggressiveness(legacy) })}`,
      );
      failures += 1;
    }
  }

  if (failures > 0) {
    console.error(`\n❌ smoke-local: ${failures} проверок провалено`);
    process.exit(1);
  }
  console.log('\n✅ smoke-local: все проверки пройдены');
}

main();
