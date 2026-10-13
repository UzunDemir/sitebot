/**
 * Prompt assembly: the bot's own prompt + behavior directives
 * (chattiness, goal, sales pressure, sources) + grounded context.
 */

import type { RetrievedChunk } from './retrieval';
import type { BotChattiness, BotGoal, BotSettings } from './bot-settings';

const CHATTINESS_RULES: Record<BotChattiness, string> = {
  strict:
    'Стиль общения: отвечай точно на заданный вопрос, коротко. Встречные вопросы — только если без них нельзя ответить.',
  friendly:
    'Стиль общения: дружелюбно и по делу. Можешь задать один уточняющий вопрос, если это помогает ответу.',
  proactive:
    'Стиль общения: будь проактивным — предлагай уместные варианты и следующий шаг, мягко уточняй потребность.',
  initiator:
    'Стиль общения: ты ведёшь беседу к цели. Задавай по одному вопросу за сообщение и направляй диалог к результату.',
};

const GOAL_RULES: Record<Exclude<BotGoal, 'none' | 'custom'>, string> = {
  call: 'Цель диалога: договориться о звонке — в подходящий момент предложи оставить номер телефона.',
  purchase: 'Цель диалога: помочь с покупкой — доведи клиента до оформления заказа.',
  phone: 'Цель диалога: получить номер телефона клиента для связи (предложи в подходящий момент).',
  birthday:
    'Цель диалога: аккуратно, после ответа на вопрос клиента, узнать дату рождения для поздравлений.',
};

const PRESSURE_RULES: Record<0 | 1 | 2, string> = {
  0: 'Продажи: без давления — упоминай товары/услуги только если это уместно.',
  1: 'Продажи: умеренно предлагай подходящие товары/услуги после ответа на вопрос.',
  2: 'Продажи: активно предлагай варианты и завершение покупки. Жёсткие ограничения: не давить после двух явных отказов, не выдумывать выгоды и скидки, не манипулировать.',
};

function goalRule(settings: BotSettings): string | null {
  const goal = settings.goal;
  if (!goal || goal === 'none') return null;
  if (goal === 'custom') {
    const text = settings.goalText?.trim();
    return text ? `Цель диалога: ${text}` : null;
  }
  return GOAL_RULES[goal];
}

export function buildSystemPrompt(
  botSystemPrompt: string,
  sources: RetrievedChunk[],
  settings: BotSettings = {},
): string {
  const context = sources
    .map((source, index) => {
      const title = source.title ? `${source.title}: ` : '';
      return `[${index + 1}] ${title}${source.content}`;
    })
    .join('\n\n');

  const showSources = settings.showSources !== false;
  const sourceRule = showSources
    ? '- После утверждений из контекста ставь ссылку на источник: [1], [2] и т.д.'
    : '- В ответе не указывай источники и маркеры [n] — отвечай обычным текстом.';

  const blocks: string[] = [botSystemPrompt.trim()];
  const chattiness = settings.chattiness ? CHATTINESS_RULES[settings.chattiness] : null;
  if (chattiness) blocks.push(chattiness);
  const goal = goalRule(settings);
  if (goal) blocks.push(goal);
  blocks.push(PRESSURE_RULES[settings.salesPressure ?? 0]);

  blocks.push(
    [
      'Ниже — фрагменты базы знаний. Отвечай, опираясь ТОЛЬКО на них.',
      '- Если ответа в контексте нет — честно скажи, что не располагаешь информацией, и предложи обратиться в поддержку. Не выдумывай.',
      sourceRule,
      '- Отвечай на языке пользователя. Без markdown-разметки.',
      '',
      'КОНТЕКСТ:',
      context || '(контекст пуст — сообщи, что не можешь ответить, и предложи обратиться в поддержку)',
    ].join('\n'),
  );

  return blocks.filter(Boolean).join('\n\n');
}
