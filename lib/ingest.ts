/**
 * Document ingestion pipeline, shared by the seed script and admin uploads.
 *
 * content -> chunk -> embed (batched, paced, quota-aware) -> store,
 * with honest statuses: pending -> processing -> ready | error.
 *
 * Big documents are ingested in multiple passes: each call works within a
 * time budget (default 45s, under the 60s serverless limit) and stores
 * progress batch-by-batch. If the budget or provider limits run out, the
 * outcome is `partial` — the caller (admin UI) simply calls again and the
 * pipeline resumes from the chunks that are already stored (hash-guarded).
 */

import { createHash } from 'node:crypto';
import { getSupabase } from './supabase';
import {
  embedBatch,
  toVectorLiteral,
  EMBEDDING_DIM,
  EMBED_BATCH_SIZE,
  EMBED_BATCH_PAUSE_MS,
  BudgetExceededError,
} from './embeddings';
import { chunkDocument } from './chunker';

/** Serverless-friendly soft cap for a single document (characters). */
export const MAX_CONTENT_CHARS = 300_000;

/** Default per-call time budget (must stay below the 60s function limit). */
export const DEFAULT_TIME_BUDGET_MS = 45_000;

export type IngestInput = {
  botId: string;
  title: string;
  source?: string | null;
  content: string;
};

export type IngestOutcome = {
  documentId: string;
  /** Chunks stored for the document so far (equals total when ready). */
  chunks: number;
  /** Total chunks planned for the document. */
  total: number;
  /** Chunks added in this pass. */
  added: number;
  status: 'ready' | 'skipped' | 'partial';
};

export type IngestOptions = {
  /** How long this call may work before returning `partial`. */
  timeBudgetMs?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function ingestDocument(
  input: IngestInput,
  options: IngestOptions = {},
): Promise<IngestOutcome> {
  const deadline = Date.now() + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
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
  const drafts = chunkDocument(content);
  const total = drafts.length;

  const existing = await supabase
    .from('documents')
    .select('id, content_hash, status')
    .eq('bot_id', input.botId)
    .eq('title', title)
    .maybeSingle();
  if (existing.error) throw existing.error;

  // -------- fast path: unchanged and fully indexed
  if (existing.data && existing.data.content_hash === hash && existing.data.status === 'ready') {
    const count = await supabase
      .from('chunks')
      .select('id', { count: 'exact', head: true })
      .eq('document_id', existing.data.id);
    if ((count.count ?? 0) > 0) {
      return {
        documentId: existing.data.id as string,
        chunks: count.count ?? 0,
        total,
        added: 0,
        status: 'skipped',
      };
    }
  }

  // -------- resolve document row and resume point
  let documentId: string;
  let storedIdx = new Set<number>();

  if (existing.data) {
    documentId = existing.data.id as string;
    const sameContent = existing.data.content_hash === hash;

    if (sameContent) {
      // resume mode: keep stored chunks, re-embed only what is missing
      const rows = await supabase.from('chunks').select('idx').eq('document_id', documentId);
      if (rows.error) throw rows.error;
      storedIdx = new Set((rows.data ?? []).map((row) => row.idx as number));
      const upd = await supabase
        .from('documents')
        .update({ status: 'processing', error: null, updated_at: new Date().toISOString() })
        .eq('id', documentId);
      if (upd.error) throw upd.error;
    } else {
      // content changed: full reset
      const upd = await supabase
        .from('documents')
        .update({
          content,
          content_hash: hash,
          source: input.source ?? null,
          status: 'processing',
          error: null,
          chunk_count: 0,
          updated_at: new Date().toISOString(),
        })
        .eq('id', documentId);
      if (upd.error) throw upd.error;
      const del = await supabase.from('chunks').delete().eq('document_id', documentId);
      if (del.error) throw del.error;
    }
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

  const targets = drafts.filter((draft) => !storedIdx.has(draft.idx));
  let chunksStored = Math.min(storedIdx.size, total);

  // everything already embedded — just mark ready
  if (targets.length === 0) {
    const upd = await supabase
      .from('documents')
      .update({
        status: 'ready',
        chunk_count: total,
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', documentId);
    if (upd.error) throw upd.error;
    return { documentId, chunks: total, total, added: 0, status: 'ready' };
  }

  // -------- embed pass within the time budget
  let added = 0;
  try {
    for (let i = 0; i < targets.length; i += EMBED_BATCH_SIZE) {
      if (Date.now() >= deadline) break;
      const slice = targets.slice(i, i + EMBED_BATCH_SIZE);
      const vectors = await embedBatch(slice.map((draft) => draft.content), deadline);

      if (vectors.length !== slice.length) {
        throw new Error('Сбой эмбеддингов: количество векторов не совпало с количеством чанков.');
      }
      if (vectors[0] && vectors[0].length !== EMBEDDING_DIM) {
        throw new Error(
          `Неожиданная размерность эмбеддинга: ${vectors[0].length}, ожидали ${EMBEDDING_DIM}.`,
        );
      }

      const rows = slice.map((draft, j) => ({
        bot_id: input.botId,
        document_id: documentId,
        idx: draft.idx,
        content: draft.content,
        embedding: toVectorLiteral(vectors[j]),
      }));
      const ins = await supabase.from('chunks').insert(rows);
      if (ins.error) throw ins.error;

      added += rows.length;
      chunksStored = Math.min(total, chunksStored + rows.length);
      const progress = await supabase
        .from('documents')
        .update({ chunk_count: chunksStored, updated_at: new Date().toISOString() })
        .eq('id', documentId);
      if (progress.error) throw progress.error;

      if (i + EMBED_BATCH_SIZE < targets.length && Date.now() + EMBED_BATCH_PAUSE_MS < deadline) {
        await sleep(EMBED_BATCH_PAUSE_MS);
      }
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      const upd = await supabase
        .from('documents')
        .update({ chunk_count: chunksStored, updated_at: new Date().toISOString() })
        .eq('id', documentId);
      if (upd.error) throw upd.error;
      return { documentId, chunks: chunksStored, total, added, status: 'partial' };
    }
    const raw = err instanceof Error ? err.message : String(err);
    console.error('[ingest] failed:', raw);
    const message = /quota|rate limit|resource_exhausted|429|exceeded/i.test(raw)
      ? 'Превышен лимит бесплатного тарифа Google на эмбеддинги. Прогресс сохранён — подождите минуту-две и нажмите «повторить», обработка продолжится.'
      : raw;
    await supabase
      .from('documents')
      .update({ status: 'error', error: message, updated_at: new Date().toISOString() })
      .eq('id', documentId);
    throw new Error(message);
  }

  // -------- finish (or report partial progress for the next pass)
  if (chunksStored >= total) {
    const upd = await supabase
      .from('documents')
      .update({
        status: 'ready',
        chunk_count: total,
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', documentId);
    if (upd.error) throw upd.error;
    return { documentId, chunks: total, total, added, status: 'ready' };
  }

  return { documentId, chunks: chunksStored, total, added, status: 'partial' };
}
