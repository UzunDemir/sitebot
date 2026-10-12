/**
 * Hybrid retrieval: pgvector (semantic) + Postgres FTS (lexical),
 * merged with Reciprocal Rank Fusion (RRF, k=60).
 */

import { getSupabase } from './supabase';
import { embedQuery, toVectorLiteral } from './embeddings';

export type RetrievedChunk = {
  chunkId: number;
  documentId: string;
  content: string;
  idx: number;
  similarity: number | null;
  rrf: number;
  title: string | null;
  source: string | null;
};

type VectorRow = {
  chunk_id: number;
  document_id: string;
  content: string;
  idx: number;
  similarity: number;
};

type FtsRow = {
  chunk_id: number;
  document_id: string;
  content: string;
  idx: number;
  rank: number;
};

const RRF_K = 60;
const CANDIDATES = 8;

export async function hybridSearch(
  botId: string,
  query: string,
  topK: number,
): Promise<RetrievedChunk[]> {
  const supabase = getSupabase();
  const embedding = await embedQuery(query);

  const [vectorRes, ftsRes] = await Promise.all([
    supabase.rpc('match_chunks', {
      p_bot_id: botId,
      p_query_embedding: toVectorLiteral(embedding),
      p_match_count: CANDIDATES,
    }),
    supabase.rpc('search_chunks_fts', {
      p_bot_id: botId,
      p_query: query,
      p_match_count: CANDIDATES,
    }),
  ]);

  if (vectorRes.error) {
    throw new Error(`Vector search failed: ${vectorRes.error.message}`);
  }
  // FTS failure is non-fatal: vector branch can still answer.
  if (ftsRes.error) {
    console.warn('[retrieval] FTS branch failed:', ftsRes.error.message);
  }

  const merged = new Map<number, RetrievedChunk>();

  ((vectorRes.data ?? []) as VectorRow[]).forEach((row, index) => {
    merged.set(row.chunk_id, {
      chunkId: row.chunk_id,
      documentId: row.document_id,
      content: row.content,
      idx: row.idx,
      similarity: row.similarity,
      rrf: 1 / (RRF_K + index + 1),
      title: null,
      source: null,
    });
  });

  ((ftsRes.error ? [] : ftsRes.data ?? []) as FtsRow[]).forEach((row, index) => {
    const contribution = 1 / (RRF_K + index + 1);
    const existing = merged.get(row.chunk_id);
    if (existing) {
      existing.rrf += contribution;
    } else {
      merged.set(row.chunk_id, {
        chunkId: row.chunk_id,
        documentId: row.document_id,
        content: row.content,
        idx: row.idx,
        similarity: null,
        rrf: contribution,
        title: null,
        source: null,
      });
    }
  });

  const top = [...merged.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, topK);

  // Attach document titles/sources for citations.
  const documentIds = [...new Set(top.map((chunk) => chunk.documentId))];
  if (documentIds.length > 0) {
    const { data: documents, error } = await supabase
      .from('documents')
      .select('id, title, source')
      .in('id', documentIds);
    if (error) {
      console.warn('[retrieval] failed to load document metadata:', error.message);
    } else {
      const byId = new Map(
        (documents ?? []).map((doc) => [doc.id as string, doc as { title: string; source: string | null }]),
      );
      for (const chunk of top) {
        const doc = byId.get(chunk.documentId);
        if (doc) {
          chunk.title = doc.title;
          chunk.source = doc.source;
        }
      }
    }
  }

  return top;
}
