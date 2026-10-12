/**
 * Pluggable embedding layer.
 *
 * Default (and currently only) provider: Google AI Studio free tier,
 * gemini-embedding-001 truncated to 1536 dims (MRL) — matches the
 * vector(1536) columns in sql/0001_init.sql.
 *
 * Free-tier quotas are tight (requests are counted per embedded text):
 *   * batches are small and paced (EMBED_BATCH_PAUSE_MS between batches)
 *   * rate-limit errors are retried after the delay the API suggests
 *     ("Please retry in Xs")
 *   * callers may pass a deadline; if the next wait would overrun it,
 *     BudgetExceededError is raised so long jobs can resume gracefully
 *     in a follow-up pass instead of being killed by a serverless timeout.
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

/** Batch size for document embedding calls (1 text = 1 quota request). */
export const EMBED_BATCH_SIZE = 24;

/** Pause between document batches to stay under provider rate limits. */
export const EMBED_BATCH_PAUSE_MS = 10_000;

type EmbeddingCallKind = 'document' | 'query';

/** Raised when a retry wait would exceed the caller's time budget. */
export class BudgetExceededError extends Error {
  constructor() {
    super('Embedding time budget exceeded');
    this.name = 'BudgetExceededError';
  }
}

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
  opts: { maxAttempts?: number; deadline?: number } = {},
): Promise<number[][]> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const { deadline } = opts;

  for (let attempt = 1; ; attempt += 1) {
    if (deadline && Date.now() >= deadline) throw new BudgetExceededError();
    try {
      const { embeddings } = await embedMany({ model, values, providerOptions });
      return embeddings;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= maxAttempts || !RATE_LIMIT_PATTERN.test(message)) throw err;
      const delay = retryDelaySeconds(message);
      if (deadline && Date.now() + delay * 1000 >= deadline) throw new BudgetExceededError();
      console.warn(
        `[embeddings] лимит провайдера (попытка ${attempt}/${maxAttempts}), пауза ${delay}с…`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    }
  }
}

/**
 * Embed one batch of texts (<= EMBED_BATCH_SIZE recommended).
 * `deadline` (ms epoch) makes the call abandon long rate-limit waits
 * via BudgetExceededError instead of overrunning the caller's budget.
 */
export async function embedBatch(texts: string[], deadline?: number): Promise<number[][]> {
  const model = getModel();
  return embedManyWithRetry(model, texts, { google: googleOptions('document') }, { deadline });
}

/** Embed many texts, batching and pacing. Returns vectors in the same order. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const embeddings = await embedBatch(batch);
    out.push(...embeddings);
    if (i + EMBED_BATCH_SIZE < texts.length) {
      await new Promise((resolve) => setTimeout(resolve, EMBED_BATCH_PAUSE_MS));
    }
  }
  return out;
}

/** Embed a single retrieval query (short, capped retry wait). */
export async function embedQuery(text: string): Promise<number[]> {
  const model = getModel();
  const maxAttempts = 2;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { embedding } = await embed({ model, value: text, providerOptions: { google: googleOptions('query') } });
      return embedding;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= maxAttempts || !RATE_LIMIT_PATTERN.test(message)) throw err;
      const delay = Math.min(retryDelaySeconds(message), 25);
      console.warn(`[embeddings] лимит провайдера на запросе (попытка ${attempt}/${maxAttempts}), пауза ${delay}с…`);
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    }
  }
}

/**
 * pgvector text literal, e.g. "[0.1,-0.2,...]".
 * Used for PostgREST writes and RPC calls so the value is cast
 * deterministically (string -> vector), independent of JSON coercion quirks.
 */
export function toVectorLiteral(vector: number[]): string {
  return '[' + vector.join(',') + ']';
}
