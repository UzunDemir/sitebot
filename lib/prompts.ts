/**
 * Prompt assembly: the bot's own prompt + behavior directives
 * (chattiness, goal, aggressiveness, tone, visitor memory, sources)
 * + grounded context.
 */

import type { RetrievedChunk } from './retrieval';
import { KNOWLEDGE_BUDGET, selectedKnowledgePacks } from './knowledge-packs';
import {
  BOT_SETTINGS_DEFAULTS,
  effectiveAggressiveness,
  type BotChattiness,
  type BotGoal,
  type BotSettings,
} from './bot-settings';

/**
 * Гигиена контекста: устаревшие шаблонные отказы («не храню историю»,
 * «доступа к календарю/часам нет») заражают модель — она копирует их в новых
 * ответах. В контексте модели такие сообщения заменяются маркером.
 */
const ECHOED_REFUSALS =
  /не\s+храню\s+(историю|переписк)|истори[юи]\s+переписки\s+я\s+не|доступа\s+к\s+(ней|истории|переписке|календарю|часам)\s+у\s+меня\s+нет|воспроизвести\s+(её|ее|историю|переписку)\s+не\s+могу/i;

export function sanitizeEchoedRefusal(content: string): string {
  return ECHOED_REFUSALS.test(content) ? '(устаревший ответ пропущен)' : content;
}

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
  phone: 'Цель диалога: получить номер телефона клиента для связи (предложи в подходящий момент).',
  messenger:
    'Цель диалога: перевести общение в мессенджер (Telegram/WhatsApp) — в подходящий момент предложи продолжить там.',
  call: 'Цель диалога: договориться о звонке — в подходящий момент предложи оставить номер телефона.',
  booking: 'Цель диалога: записать посетителя на визит/примерку — предложи выбрать удобное время.',
  demo: 'Цель диалога: договориться о коротком демо/показе — предложи удобный формат и время.',
  purchase: 'Цель диалога: помочь с покупкой — доведи клиента до оформления заказа.',
  order: 'Цель диалога: оформить заказ — уточни позицию и предложи оформить прямо сейчас.',
  quote:
    'Цель диалога: подготовить расчёт/предложение — уточни параметры и предложи оставить контакт для сметы.',
  review: 'Цель диалога: получить короткий отзыв — попроси его после того, как помог.',
  birthday:
    'Цель диалога: аккуратно, после ответа на вопрос клиента, узнать дату рождения для поздравлений.',
};

/** Short labels for the nudge prompt («Цель диалога: ...»). */
const GOAL_SHORT: Record<Exclude<BotGoal, 'none' | 'custom'>, string> = {
  phone: 'получить телефон посетителя',
  messenger: 'перевести переписку в мессенджер',
  call: 'договориться о звонке',
  booking: 'записать на визит/примерку',
  demo: 'договориться о демо',
  purchase: 'довести до покупки',
  order: 'оформить заказ',
  quote: 'подготовить расчёт',
  review: 'получить отзыв',
  birthday: 'узнать день рождения',
};

export function goalLabelText(settings: BotSettings): string | null {
  const goal = settings.goal;
  if (!goal || goal === 'none') return null;
  if (goal === 'custom') return settings.goalText?.trim() || null;
  return GOAL_SHORT[goal] ?? null;
}

function goalRule(settings: BotSettings): string | null {
  const goal = settings.goal;
  if (!goal || goal === 'none') return null;
  if (goal === 'custom') {
    const text = settings.goalText?.trim();
    return text ? `Цель диалога: ${text}` : null;
  }
  return GOAL_RULES[goal];
}

/** Aggressiveness scale 0..100 → behavior directive (with hard guardrails). */
function aggressivenessRule(value: number): string {
  if (value <= 20) {
    return 'Продажи (шкала 0–100, низкая): без давления — упоминай товары/услуги только если это уместно.';
  }
  if (value <= 45) {
    return 'Продажи (шкала 0–100, умеренная): после ответа на вопрос можешь один раз мягко предложить подходящий вариант.';
  }
  if (value <= 70) {
    return 'Продажи (шкала 0–100, выше средней): веди посетителя к цели — в ответе делай один шаг: уточни потребность или предложи следующий шаг.';
  }
  return 'Продажи (шкала 0–100, высокая): активно веди к цели, предлагай завершение и контакт. Жёсткие ограничения: не давить после двух явных отказов, не выдумывать выгоды и скидки, не манипулировать.';
}

function toneRule(value: number): string | null {
  if (value >= 70) return 'Тон: официальный, сдержанный — «вы», без сленга и эмодзи.';
  if (value <= 30) return 'Тон: дружеский, тёплый — допустимы лёгкие разговорные формулировки, без панибратства.';
  return null;
}

/** Шкалы характера (юмор / хитрость / остроумие) → директивы поведения. */
export function personalityRules(settings: BotSettings): string[] {
  const rules: string[] = [];

  const humor = settings.humor ?? BOT_SETTINGS_DEFAULTS.humor;
  if (humor <= 20) {
    rules.push('Юмор (0–20): без шуток — тепло, но серьёзно и по делу.');
  } else if (humor <= 60) {
    rules.push('Юмор (21–60): допустима лёгкая уместная шутка, если она к месту.');
  } else {
    rules.push(
      'Юмор (61–100): шути активно и тепло. Никогда не шути над клиентом, его проблемой или деньгами; сомневаешься, уместно ли — не шути.',
    );
  }

  const cunning = settings.cunning ?? BOT_SETTINGS_DEFAULTS.cunning;
  if (cunning <= 20) {
    rules.push('Хитрость (0–20): говори прямо, без приёмов убеждения.');
  } else if (cunning <= 60) {
    rules.push(
      'Хитрость (21–60): можно мягкие приёмы — интрига, встречный вопрос, акцент на выгоде клиента.',
    );
  } else {
    rules.push(
      'Хитрость (61–100): веди к цели изобретательно — вместо «нет» предлагай альтернативу, создавай интригу и показывай выгоду. Честность неприкосновенна: никаких выдуманных скидок, дефицита и обещаний.',
    );
  }

  const wit = settings.wit ?? BOT_SETTINGS_DEFAULTS.wit;
  if (wit <= 20) {
    rules.push('Остроумие (0–20): простые, ясные формулировки.');
  } else if (wit <= 60) {
    rules.push('Остроумие (21–60): живые формулировки, меткие фразы.');
  } else {
    rules.push(
      'Остроумие (61–100): остроумно и неожиданно, можно игру слов — но всегда по делу и понятно клиенту.',
    );
  }

  const empathy = settings.empathy ?? BOT_SETTINGS_DEFAULTS.empathy;
  if (empathy >= 70) {
    rules.push(
      'Эмпатия (70–100): сначала признай чувства и ситуацию клиента («понимаю», «представляю»), затем предлагай решение.',
    );
  } else if (empathy <= 30) {
    rules.push('Эмпатия (0–30): деловой тон без эмоциональных формулировок.');
  }

  return rules;
}

/** Visitor memory (sql/0003/0004): injected so the bot never re-asks known facts. */
export type VisitorMemoryContext = {
  name: string | null;
  contacts: Record<string, string>;
  interests: string[];
  digest: string;
  stage: string;
  returning: boolean;
  /** «5 марта» / «5 марта 1990» — день рождения из карточки. */
  birthday: string | null;
  /** Сегодня у посетителя день рождения (в его таймзоне). */
  birthdayToday: boolean;
  preferences: string[];
  complaints: string[];
  /** «2 покупки; последняя — «Пуховик Arctic», 12 900 ₽; всего на 24 400 ₽». */
  purchases: string | null;
};

const STAGE_HINTS: Record<string, string> = {
  greeting: 'приветствие — поздоровайся и выясни, что нужно посетителю',
  qualification: 'квалификация — выясни потребность одним уточняющим вопросом',
  offer: 'предложение — предложи конкретный вариант под потребность',
  objections: 'возражения — сними возражение честно, без давления',
  close: 'закрытие — предложи следующий шаг (оформление, контакт, звонок)',
  followup: 'дожим — посетитель молчал: мягко напомни о себе простым вопросом',
  done: 'цель достигнута — закрепи договорённость',
  lost: 'диалог не сложился — отвечай нейтрально',
};

function memoryBlock(memory: VisitorMemoryContext): string | null {
  const lines: string[] = [];
  if (memory.name) lines.push(`Имя: ${memory.name}`);
  if (memory.birthday) {
    lines.push(`День рождения: ${memory.birthday}${memory.birthdayToday ? ' — СЕГОДНЯ! Поздравь уместно.' : ''}`);
  }
  const contacts = Object.entries(memory.contacts)
    .slice(0, 5)
    .map(([key, value]) => `${key}: ${value}`)
    .join('; ');
  if (contacts) lines.push(`Контакты: ${contacts}`);
  if (memory.interests.length > 0) lines.push(`Интересы: ${memory.interests.slice(0, 5).join(', ')}`);
  if (memory.preferences.length > 0) lines.push(`Предпочтения: ${memory.preferences.slice(0, 6).join('; ')}`);
  if (memory.complaints.length > 0) lines.push(`Претензии (не игнорируй, предложи решение): ${memory.complaints.slice(0, 4).join('; ')}`);
  if (memory.digest) lines.push(`Заметки: ${memory.digest.slice(0, 600)}`);
  if (memory.purchases) lines.push(`Покупки: ${memory.purchases}`);
  const stage = STAGE_HINTS[memory.stage];
  if (stage) lines.push(`Стадия диалога: ${stage}`);
  if (lines.length === 0) return null;

  const header = memory.returning
    ? 'Посетитель уже общался с ботом ранее. Память о нём (не переспрашивай известное):'
    : 'Память о посетителе:';
  return [header, ...lines.map((line) => `- ${line}`)].join('\n');
}

export function buildSystemPrompt(
  botSystemPrompt: string,
  sources: RetrievedChunk[],
  settings: BotSettings = {},
  memory?: VisitorMemoryContext,
  nowText?: string,
  /** Жёсткие правила текущего ответа (lib/style.ts) — приоритетнее шкал. */
  styleBlock?: string | null,
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
  blocks.push(aggressivenessRule(effectiveAggressiveness(settings)));
  const tone = toneRule(settings.tone ?? 50);
  if (tone) blocks.push(tone);
  blocks.push(...personalityRules(settings));

  // Ф7: наборы знаний (техника и стиль; факты — по-прежнему из базы/диалога).
  const packs = selectedKnowledgePacks(settings.packs);
  if (packs.length > 0) {
    let budget = KNOWLEDGE_BUDGET;
    for (const pack of packs) {
      if (pack.prompt.length > budget) break;
      budget -= pack.prompt.length;
      blocks.push(
        `Профессиональный набор «${pack.title}» (приёмы и стиль; факты — только из базы знаний и диалога):\n${pack.prompt}`,
      );
    }
  }
  const customKnowledge = settings.customKnowledge?.trim();
  if (customKnowledge) {
    blocks.push(
      `Дополнительные знания владельца (стиль и контекст; не выдумывай факты):\n${customKnowledge.slice(0, 2000)}`,
    );
  }
  if (nowText) {
    blocks.push(
      [
        `Текущие дата и время: ${nowText}.`,
        'Это точные системные данные: считай их фактом, приоритетнее базы знаний и истории диалога.',
        'Вопрос о дате, дне недели, числе или времени («какой сегодня день», «время», «который час») — отвечай сразу из этой строки, например: «Сегодня среда, 14 октября, сейчас 15:00».',
        'Никогда не отвечай, что у тебя «нет доступа к календарю/часам» или что ты «не подсказываешь время», — эти данные у тебя есть выше. Не копируй прежние отказы из истории диалога.',
        'Если посетитель спрашивает время повторно — отвечай заново по этой строке: время могло измениться. Не повторяй время из прежних ответов.',
        'Учитывай текущие дату и время суток: сроки («сегодня», «завтра»), приветствия по времени дня, планы и поздравления. Непротиворечь этому блоку.',
      ].join('\n'),
    );
  }
  const memoryText = memory ? memoryBlock(memory) : null;
  if (memoryText) blocks.push(memoryText);

  const contextLines = [
    'Ниже — фрагменты базы знаний. Отвечай, опираясь ТОЛЬКО на них.',
    '- Если ответа в контексте нет — честно скажи, что не располагаешь информацией, и предложи обратиться в поддержку. Не выдумывай.',
    '- Исключения (не требуют базы знаний): текущие дата и время — из блока «Текущие дата и время»; вопросы о диалоге («о чём мы говорили») — краткий пересказ по истории выше.',
    sourceRule,
    '- Отвечай на языке пользователя. Без markdown-разметки.',
  ];
  if (nowText) {
    contextLines.push(
      `- Сейчас ${nowText}.`,
      '- Дата и время — не из базы знаний: отвечай по строке «Сейчас» выше; при повторном вопросе о времени — заново, не повторяй время из прежних ответов.',
    );
  }
  contextLines.push(
    '',
    'КОНТЕКСТ:',
    context || '(контекст пуст — сообщи, что не можешь ответить, и предложи обратиться в поддержку)',
  );
  blocks.push(contextLines.join('\n'));

  blocks.push(
    [
      'Память диалога: переписка с посетителем доступна тебе в истории выше, его карточка — в блоке памяти. Ты помнишь этот разговор.',
      'Вопросы «о чём мы говорили», «что я спрашивал», «помнишь меня», «история переписки/разговоров», «перескажи наш разговор» — отвечай кратким пересказом этого диалога (2–4 пункта, по делу) и продолжай помогать. Пересказывай только то, что есть в истории; ничего не выдумывай.',
      'Никогда не говори, что «не хранишь историю переписки» или что «доступа к ней нет»: это запрещённый устаревший отказ, не копируй его из своих прошлых ответов.',
    ].join('\n'),
  );

  if (styleBlock) {
    blocks.push(styleBlock);
  }

  return blocks.filter(Boolean).join('\n\n');
}
