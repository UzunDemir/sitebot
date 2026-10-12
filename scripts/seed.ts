/**
 * Idempotent seed script: demo bot + knowledge base.
 *
 * Usage: npm run seed   (reads .env.local from the project root)
 *
 * What it does:
 *   1. loads .env.local
 *   2. checks schema connectivity (prints actionable errors)
 *   3. creates/updates the demo bot
 *   4. for each demo document: chunks -> embeddings (Google) -> upsert into Supabase
 *   5. skips unchanged documents (hash + status = ready)
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getSupabase } from '../lib/supabase';
import { embedTexts, toVectorLiteral, EMBEDDING_DIM } from '../lib/embeddings';
import { chunkDocument } from '../lib/chunker';
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
    console.error('   2) Проверьте SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в .env.local');
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

  // --- documents + chunks
  let embeddedChunks = 0;
  for (const doc of DEMO_KB) {
    const hash = createHash('sha256').update(doc.content).digest('hex');

    const existing = await supabase
      .from('documents')
      .select('id, content_hash, status')
      .eq('bot_id', botId)
      .eq('title', doc.title)
      .maybeSingle();
    if (existing.error) throw existing.error;

    if (existing.data && existing.data.content_hash === hash && existing.data.status === 'ready') {
      const count = await supabase
        .from('chunks')
        .select('id', { count: 'exact', head: true })
        .eq('document_id', existing.data.id);
      if ((count.count ?? 0) > 0) {
        console.log(`↷ ${doc.title} — без изменений (${count.count} чанков)`);
        continue;
      }
    }

    let documentId: string;
    if (existing.data) {
      documentId = existing.data.id as string;
      const upd = await supabase
        .from('documents')
        .update({
          content: doc.content,
          content_hash: hash,
          source: doc.source,
          status: 'processing',
          error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', documentId);
      if (upd.error) throw upd.error;
      const del = await supabase.from('chunks').delete().eq('document_id', documentId);
      if (del.error) throw del.error;
    } else {
      const ins = await supabase
        .from('documents')
        .insert({
          bot_id: botId,
          title: doc.title,
          source: doc.source,
          content: doc.content,
          content_hash: hash,
          status: 'processing',
        })
        .select('id')
        .single();
      if (ins.error) throw ins.error;
      documentId = ins.data.id as string;
    }

    try {
      const drafts = chunkDocument(doc.content);
      const vectors = await embedTexts(drafts.map((draft) => draft.content));
      if (vectors.length !== drafts.length) {
        throw new Error(`количество эмбеддингов (${vectors.length}) не совпадает с чанками (${drafts.length})`);
      }
      if (vectors[0] && vectors[0].length !== EMBEDDING_DIM) {
        throw new Error(`неожиданная размерность эмбеддинга: ${vectors[0].length}, ожидали ${EMBEDDING_DIM}`);
      }

      const rows = drafts.map((draft, i) => ({
        bot_id: botId,
        document_id: documentId,
        idx: draft.idx,
        content: draft.content,
        embedding: toVectorLiteral(vectors[i]),
      }));

      const insChunks = await supabase.from('chunks').insert(rows);
      if (insChunks.error) throw insChunks.error;

      const updDoc = await supabase
        .from('documents')
        .update({
          status: 'ready',
          chunk_count: rows.length,
          error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', documentId);
      if (updDoc.error) throw updDoc.error;

      embeddedChunks += rows.length;
      console.log(`✓ ${doc.title} — ${rows.length} чанков`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await supabase.from('documents').update({ status: 'error', error: message }).eq('id', documentId);
      throw new Error(`Документ «${doc.title}»: ${message}`);
    }
  }

  const stats = await supabase
    .from('chunks')
    .select('id', { count: 'exact', head: true })
    .eq('bot_id', botId);
  console.log(`\n✅ Готово. Векторов создано в этом прогоне: ${embeddedChunks}. Всего чанков у бота: ${stats.count ?? '?'}`);
  console.log('▶ Дальше: npm run dev → http://localhost:3000');
}

main().catch((err) => {
  console.error('\n❌ Seed не завершён:', err instanceof Error ? err.message : err);
  process.exit(1);
});
