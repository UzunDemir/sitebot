/**
 * Idempotent seed script: demo bot + knowledge base.
 *
 * Usage: npm run seed   (reads .env.local from the project root)
 */

import { readFileSync, existsSync } from 'node:fs';
import { getSupabase } from '../lib/supabase';
import { ingestDocument } from '../lib/ingest';
import { DEMO_KB } from './demo-kb';

function loadEnvLocal(): void {
  const path = '.env.local';
  if (!existsSync(path)) {
    console.error('❌ Файл .env.local не найден. Скопируйте .env.example в .env.local и заполните ключи.');
    process.exit(1);
  }
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

const BOT_NAME = 'Демо: интернет-магазин «Северный»';

const SYSTEM_PROMPT = [
  'Ты — ассистент поддержки интернет-магазина «Северный».',
  'Помогаешь с вопросами о доставке, возврате, оплате, гарантии, размерах и бонусной программе.',
  'Будь вежливым и конкретным: называй сроки и суммы из контекста.',
  'Не выдумывай факты: если данных нет в контексте — скажи об этом и предложи написать на support@severny.example.',
].join(' ');

const GREETING =
  'Здравствуйте! Я ассистент магазина «Северный». Спросите про доставку, возврат, оплату, гарантию или размеры — найду ответ в базе знаний и покажу источник.';

async function main(): Promise<void> {
  loadEnvLocal();
  const supabase = getSupabase();

  // --- connectivity / schema check
  const probe = await supabase.from('bots').select('id').limit(1);
  if (probe.error) {
    console.error('❌ Нет доступа к таблице bots:', probe.error.message);
    console.error('   1) Выполните sql/0001_init.sql в Supabase → SQL Editor');
    console.error('   2) Проверьте SUPABASE_URL и серверный ключ (SUPABASE_SERVICE_ROLE_KEY или SUPABASE_SECRET_KEY) в .env.local');
    process.exit(1);
  }

  // --- bot
  const existingBot = await supabase
    .from('bots')
    .select('id, public_key')
    .eq('name', BOT_NAME)
    .maybeSingle();
  if (existingBot.error) throw existingBot.error;

  const botFields = {
    model_id: 'deepseek:deepseek-flash',
    system_prompt: SYSTEM_PROMPT,
    greeting: GREETING,
    top_k: 6,
    thinking_enabled: false,
    is_active: true,
  };

  let botId: string;
  let publicKey: string;
  if (existingBot.data) {
    botId = existingBot.data.id as string;
    publicKey = existingBot.data.public_key as string;
    const upd = await supabase.from('bots').update(botFields).eq('id', botId);
    if (upd.error) throw upd.error;
    console.log(`🤖 Бот обновлён: ${BOT_NAME}`);
  } else {
    const ins = await supabase
      .from('bots')
      .insert({ name: BOT_NAME, ...botFields })
      .select('id, public_key')
      .single();
    if (ins.error) throw ins.error;
    botId = ins.data.id as string;
    publicKey = ins.data.public_key as string;
    console.log(`🤖 Бот создан: ${BOT_NAME}`);
  }
  console.log(`   public_key: ${publicKey}`);

  // --- documents (shared ingestion pipeline)
  let createdChunks = 0;
  let skippedDocs = 0;
  const failed: string[] = [];

  for (const doc of DEMO_KB) {
    try {
      const outcome = await ingestDocument({
        botId,
        title: doc.title,
        source: doc.source,
        content: doc.content,
      });
      if (outcome.status === 'skipped') {
        skippedDocs += 1;
        console.log(`↷ ${doc.title} — без изменений (${outcome.chunks} чанков)`);
      } else {
        createdChunks += outcome.chunks;
        console.log(`✓ ${doc.title} — ${outcome.chunks} чанков`);
      }
    } catch (err) {
      failed.push(doc.title);
      console.error(`❌ ${doc.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const stats = await supabase
    .from('chunks')
    .select('id', { count: 'exact', head: true })
    .eq('bot_id', botId);
  console.log(
    `\nИтог: ${createdChunks} новых чанков, ${skippedDocs} документов без изменений, ошибок: ${failed.length}. Всего чанков: ${stats.count ?? '?'}`,
  );

  if (failed.length > 0) {
    console.error('❌ Не удалось обработать:', failed.join(', '));
    process.exit(1);
  }
  console.log('✅ Готово. Дальше: npm run dev → http://localhost:3000');
}

main().catch((err) => {
  console.error('\n❌ Seed не завершён:', err instanceof Error ? err.message : err);
  process.exit(1);
});
