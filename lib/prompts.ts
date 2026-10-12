/**
 * Prompt assembly: bot's own system prompt + grounded context blocks.
 */

import type { RetrievedChunk } from './retrieval';

export function buildSystemPrompt(botSystemPrompt: string, sources: RetrievedChunk[]): string {
  const context = sources
    .map((source, index) => {
      const title = source.title ? `${source.title}: ` : '';
      return `[${index + 1}] ${title}${source.content}`;
    })
    .join('\n\n');

  return `${botSystemPrompt}

Ниже — фрагменты базы знаний. Отвечай, опираясь ТОЛЬКО на них.

Правила:
- Если ответа в контексте нет — честно скажи, что не располагаешь информацией, и предложи обратиться в поддержку. Не выдумывай.
- После утверждений, взятых из контекста, ставь ссылку на источник: [1], [2] и т.д.
- Отвечай на языке пользователя, кратко и по делу. Без markdown-разметки.

КОНТЕКСТ:
${context || '(контекст пуст — сообщи, что не можешь ответить, и предложи обратиться в поддержку)'}`;
}
