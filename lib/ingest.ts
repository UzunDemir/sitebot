/**
 * Document ingestion pipeline, shared by the seed script and admin uploads.
 *
 * content -> chunk -> embed (batched) -> store, with honest statuses:
 *   pending -> processing -> ready | error (error text is kept on the row).
 * Re-uploading the same title with unchanged content is skipped (content hash).
 */

import { createHash } from 'node:crypto';
import { getSupabase } from './supabase';
import { embedTexts, toVectorLiteral, EMBEDDING_DIM } from './embeddings';
import { chunkDocument } from './chunker';

/** Serverless-friendly soft cap for a single document (characters). */
export const MAX_CONTENT_CHARS = 300_000;

export type IngestInput = {
  botId: string;
  title: string;
  source?: string | null;
  content: string;
};

export type IngestOutcome = {
  documentId: string;
  chunks: number;
  status: 'ready' | 'skipped';
};

export async function ingestDocument(input: IngestInput): Promise<IngestOutcome> {
  const supabase = getSupabase();
  const content = input.content.trim();
  const title = input.title.trim();

  if (!content) throw new Error('Документ пустой — нечего индексировать.');
  if (!title) throw new Error('Нужно название документа.');
  if (content.length > MAX_CONTENT_CHARS) {
    throw new Error(
      `Слишком большой текст: ${content.length.toLocaleString('ru-RU')} символов ` +
        `(лимит ${MAX_CONTENT_CHARS.toLocaleString('ru-RU')}). Разделите на несколько документов.`,
    );
  }

  const hash = createHash('sha256').update(content).digest('hex');

  const existing = await supabase
    .from('documents')
    .select('id, content_hash, status')
    .eq('bot_id', input.botId)
    .eq('title', title)
    .maybeSingle();
  if (existing.error) throw existing.error;

  if (existing.data && existing.data.content_hash === hash && existing.data.status === 'ready') {
    const count = await supabase
      .from('chunks')
      .select('id', { count: 'exact', head: true })
      .eq('document_id', existing.data.id);
    if ((count.count ?? 0) > 0) {
      return { documentId: existing.data.id as string, chunks: count.count ?? 0, status: 'skipped' };
    }
  }

  let documentId: string;
  if (existing.data) {
    documentId = existing.data.id as string;
    const upd = await supabase
      .from('documents')
      .update({
        content,
        content_hash: hash,
        source: input.source ?? null,
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
        bot_id: input.botId,
        title,
        source: input.source ?? null,
        content,
        content_hash: hash,
        status: 'processing',
      })
      .select('id')
      .single();
    if (ins.error) {
      if ((ins.error as { code?: string }).code === '23505') {
        throw new Error('Такой документ уже загружен (совпадает содержимое).');
      }
      throw ins.error;
    }
    documentId = ins.data.id as string;
  }

  try {
    const drafts = chunkDocument(content);
    const vectors = await embedTexts(drafts.map((draft) => draft.content));
    if (vectors.length !== drafts.length) {
      throw new Error('Сбой эмбеддингов: количество векторов не совпало с количеством чанков.');
    }
    if (vectors[0] && vectors[0].length !== EMBEDDING_DIM) {
      throw new Error(`Неожиданная размерность эмбеддинга: ${vectors[0].length}, ожидали ${EMBEDDING_DIM}.`);
    }

    const rows = drafts.map((draft, i) => ({
      bot_id: input.botId,
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

    return { documentId, chunks: rows.length, status: 'ready' };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error('[ingest] failed:', raw);
    const message = /quota|rate limit|resource_exhausted|429|exceeded/i.test(raw)
      ? 'Превышен лимит бесплатного тарифа Google на эмбеддинги. Текст документа сохранён — подождите минуту-две и нажмите «повторить», обработка продолжится.'
      : raw;
    await supabase
      .from('documents')
      .update({ status: 'error', error: message, updated_at: new Date().toISOString() })
      .eq('id', documentId);
    throw new Error(message);
  }
}
