/**
 * Cost estimation table, USD per 1M tokens.
 *
 * DeepSeek off-peak prices (peak hours are 2x; see platform.deepseek.com).
 * Cache-hit input pricing is cheaper in reality — we bill conservatively
 * by using the cache-miss price.
 */

type Price = { input: number; output: number };

const PRICES: Record<string, Price> = {
  'deepseek:deepseek-flash': { input: 0.15, output: 0.6 },
  'deepseek:deepseek-v4-pro': { input: 0.66, output: 1.98 },
};

export function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICES[modelId] ?? { input: 0, output: 0 };
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}
