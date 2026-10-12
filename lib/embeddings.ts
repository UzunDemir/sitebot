/**
 * Pluggable embedding layer.
 *
 * Default (and currently only) provider: Google AI Studio free tier,
 * gemini-embedding-001 truncated to 1536 dims (MRL) — matches the
 * vector(1536) columns in sql/0001_init.sql.
 *
 * Note: embedding options (task type, output dimensionality) are passed
 * per call via providerOptions — the model instance takes only the model id.
 *
 * To switch providers later (Jina, OpenAI, ...), add a branch in getModel()
 * and update EMBEDDING_DIM + the SQL vector(N) columns, then re-run the seed
 * (changing the embedding model always requires a full re-index).
 */

import { embed, embedMany } from 'ai';
import { createGoogle } from '@ai-sdk/google';
import { env } from './env';

export const EMBEDDING_DIM = 1536;

const BATCH_SIZE = 32;

type EmbeddingCallKind = 'document' | 'query';

function getModel() {
  const e = env();
  switch (e.embeddingProvider) {
    case 'google': {
      const google = createGoogle({ apiKey: e.googleApiKey });
      return google.textEmbeddingModel('gemini-embedding-001');
    }
    default:
      throw new Error(`Unsupported embedding provider: ${e.embeddingProvider}`);
  }
}

function googleOptions(kind: EmbeddingCallKind) {
  return kind === 'document'
    ? { taskType: 'RETRIEVAL_DOCUMENT' as const, outputDimensionality: EMBEDDING_DIM }
    : { taskType: 'RETRIEVAL_QUERY' as const, outputDimensionality: EMBEDDING_DIM };
}

/** Embed a batch of document chunks. Returns vectors in the same order. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const model = getModel();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const { embeddings } = await embedMany({
      model,
      values: batch,
      providerOptions: { google: googleOptions('document') },
    });
    out.push(...embeddings);
  }
  return out;
}

/** Embed a single retrieval query. */
export async function embedQuery(text: string): Promise<number[]> {
  const model = getModel();
  const { embedding } = await embed({
    model,
    value: text,
    providerOptions: { google: googleOptions('query') },
  });
  return embedding;
}

/**
 * pgvector text literal, e.g. "[0.1,-0.2,...]".
 * Used for PostgREST writes and RPC calls so the value is cast
 * deterministically (string -> vector), independent of JSON coercion quirks.
 */
export function toVectorLiteral(vector: number[]): string {
  return '[' + vector.join(',') + ']';
}
