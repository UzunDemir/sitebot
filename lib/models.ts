/**
 * LLM registry: maps "provider:model" strings from the bots table
 * to AI SDK model instances. Adding a provider = adding a branch here
 * plus its API key in the environment.
 */

import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';
import { env } from './env';

export type ModelInfo = {
  id: string;
  label: string;
  provider: 'deepseek';
};

export const AVAILABLE_MODELS: ModelInfo[] = [
  {
    id: 'deepseek:deepseek-flash',
    label: 'DeepSeek V4.1 Flash — быстрая, для поддержки',
    provider: 'deepseek',
  },
  {
    id: 'deepseek:deepseek-v4-pro',
    label: 'DeepSeek V4 Pro — сильнее и дороже',
    provider: 'deepseek',
  },
];

export function isKnownModel(modelId: string): boolean {
  return AVAILABLE_MODELS.some((m) => m.id === modelId);
}

export function resolveModel(modelId: string): LanguageModel {
  const separator = modelId.indexOf(':');
  if (separator === -1) {
    throw new Error(`Invalid model id "${modelId}", expected "provider:model"`);
  }
  const provider = modelId.slice(0, separator);
  const model = modelId.slice(separator + 1);

  switch (provider) {
    case 'deepseek': {
      const client = createDeepSeek({ apiKey: env().deepseekApiKey });
      return client(model);
    }
    default:
      throw new Error(`Unknown LLM provider "${provider}" in model id "${modelId}"`);
  }
}
