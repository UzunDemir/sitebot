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
 * Free-tier quotas are tight: batches are paced, and provider rate-limit
 * errors are retried after the delay suggested by the API ("retry in Xs").
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
const BATCH_PAUSE_MS = 800;

type EmbeddingCallKind = 'document' | 'query';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const RATE_LIMIT_PATTERN = /quota|rate limit|resource_exhausted|429|exceeded/i;

/** Delay suggested by the provider ("Please retry in 22.04s"), clamped. */
function retryDelaySeconds(message: string): number {
  const match = message.match(/retry in ([\d.]+)s/i);
  if (match) return Math.min(60, Math.ceil(Number.parseFloat(match[1])) + 1);
  return 20;
}

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

type GoogleProviderOptions = { google: ReturnType<typeof googleOptions> };

async function embedManyWithRetry(
  model: ReturnType<typeof getModel>,
  values: string[],
  providerOptions: GoogleProviderOptions,
  maxAttempts = 4,
): Promise<number[][]> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { embeddings } = await embedMany({ model, values, providerOptions });
      return embeddings;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= maxAttempts || !RATE_LIMIT_PATTERN.test(message)) throw err;
      const delay = retryDelaySeconds(message);
      console.warn(
        `[embeddings] лимит провайдера (попытка ${attempt}/${maxAttempts}), пауза ${delay}с…`,
      );
      await sleep(delay * 1000);
    }
  }
}

async function embedWithRetry(
  model: ReturnType<typeof getModel>,
  value: string,
  providerOptions: GoogleProviderOptions,
  maxAttempts = 2,
): Promise<number[]> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { embedding } = await embed({ model, value, providerOptions });
      return embedding;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= maxAttempts || !RATE_LIMIT_PATTERN.test(message)) throw err;
      const delay = retryDelaySeconds(message);
      console.warn(
        `[embeddings] лимит провайдера (попытка ${attempt}/${maxAttempts}), пауза ${delay}с…`,
      );
      await sleep(delay * 1000);
    }
  }
}

/** Embed a batch of document chunks. Returns vectors in the same order. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const model = getModel();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const embeddings = await embedManyWithRetry(model, batch, {
      google: googleOptions('document'),
    });
    out.push(...embeddings);
    if (i + BATCH_SIZE < texts.length) {
      await sleep(BATCH_PAUSE_MS);
    }
  }
  return out;
}

/** Embed a single retrieval query. */
export async function embedQuery(text: string): Promise<number[]> {
  const model = getModel();
  return embedWithRetry(model, text, { google: googleOptions('query') }, 2);
}

/**
 * pgvector text literal, e.g. "[0.1,-0.2,...]".
 * Used for PostgREST writes and RPC calls so the value is cast
 * deterministically (string -> vector), independent of JSON coercion quirks.
 */
export function toVectorLiteral(vector: number[]): string {
  return '[' + vector.join(',') + ']';
}
