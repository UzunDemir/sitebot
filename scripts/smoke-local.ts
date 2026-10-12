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
import { DEMO_KB } from './demo-kb';

void getSupabase; // import-graph check only; not called (needs env)

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

  if (failures > 0) {
    console.error(`\n❌ smoke-local: ${failures} проверок провалено`);
    process.exit(1);
  }
  console.log('\n✅ smoke-local: все проверки пройдены');
}

main();
