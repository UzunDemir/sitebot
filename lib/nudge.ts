/**
 * Nudge engine (Ф3): stop-words, quiet hours and the touch text.
 *
 * The server is the source of truth: /api/chat/nudge asks the guards below
 * before sending anything. Pure helpers (isStopRequest, quiet-hour math,
 * sanitizeNudgeText, nudgeFallbackText) are unit-tested in smoke-local.
 */

import { generateText } from 'ai';
import { resolveModel } from './models';
import type { VisitorContacts } from './visitors';
import type { BotSettings } from './bot-settings';
import { effectiveAggressiveness } from './bot-settings';
import { goalLabelText, personalityRules } from './prompts';

/* ---------------------------------------------------------------- */
/* Stop words: an explicit request to stop writing first            */
/* ---------------------------------------------------------------- */

const STOP_WORD_PATTERNS: RegExp[] = [
  /не\s+пиш(и|ите)/i,
  /больше\s+не\s+(пиш(и|ите)|беспокой(те)?)/i,
  /отстан(ь|ьте)/i,
  /прекрати(те)?\s+(писать|слать|беспокоить)/i,
  /не\s+беспокой(те)?(\s+меня)?/i,
  /(^|[\s.,!?«"])стоп([\s.,!?»"]|$)/i,
  /\bstop\b/i,
];

/** True when the visitor asks the bot to stop writing first. */
export function isStopRequest(text: string): boolean {
  return STOP_WORD_PATTERNS.some((pattern) => pattern.test(text));
}

/** Canned calm confirmation (no LLM call for stop requests). */
export const STOP_REPLY =
  'Понял вас — больше не буду писать первым. Если понадоблюсь, просто напишите сюда.';

/* ---------------------------------------------------------------- */
/* Quiet hours (pure math on "HH:MM" strings)                       */
/* ---------------------------------------------------------------- */

export function minutesOf(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Current local time (minutes since midnight) in an IANA timezone. */
export function localMinutes(timeZone: string, now: Date): number | null {
  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
    return minutesOf(formatted);
  } catch {
    return null;
  }
}

/** [from, to) window; handles the midnight wrap (e.g., 21:00 → 09:00). */
export function inQuietWindow(nowMinutes: number, fromMinutes: number, toMinutes: number): boolean {
  if (fromMinutes === toMinutes) return false;
  if (fromMinutes < toMinutes) return nowMinutes >= fromMinutes && nowMinutes < toMinutes;
  return nowMinutes >= fromMinutes || nowMinutes < toMinutes;
}

/** The moment the quiet window that contains `now` ends. */
export function quietHoursEnd(now: Date, timeZone: string, toMinutes: number): Date | null {
  const nowMinutes = localMinutes(timeZone, now);
  if (nowMinutes === null) return null;
  const diff = (toMinutes - nowMinutes + 1440) % 1440;
  if (diff === 0) return null;
  return new Date(now.getTime() + diff * 60_000);
}

/* ---------------------------------------------------------------- */
/* Touch text: one cheap LLM call + a canned fallback               */
/* ---------------------------------------------------------------- */

const NUDGE_RULES: Record<number, string> = {
  1: 'Это первое касание: мягко напомни о себе и задай один простой вопрос по теме диалога.',
  2: 'Это второе касание: добавь новую ценность — короткий полезный факт, выгоду или ответ на то, что посетитель спрашивал.',
  3: 'Это третье касание («последнее предложение»): простой вопрос «да/нет» или предложение связаться (телефон/мессенджер).',
};

export function nudgeRule(attempt: number): string {
  return NUDGE_RULES[Math.min(Math.max(1, attempt), 3)];
}

export function nudgeFallbackText(attempt: number): string {
  if (attempt <= 1) return 'Ещё раз здравствуйте! Если остались вопросы — подскажу и помогу выбрать.';
  if (attempt === 2) {
    return 'Если удобно, продолжим: подскажу по наличию, срокам и оформлению. Что вам ближе?';
  }
  return 'Последнее предложение: напишите, что вам подходит, — помогу с заказом. Оставите телефон или мессенджер для связи?';
}

/** Trim, strip wrapping quotes, cap length; empty → null. */
export function sanitizeNudgeText(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input
    .trim()
    .replace(/^["'«»\s]+|["'«»\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
  return text || null;
}

export type NudgeContext = {
  attempt: number;
  stage: string;
  settings: BotSettings;
  visitor: { name: string | null; contacts: VisitorContacts; digest: string };
  /** sql/0004: предпочтения и претензии из карточки. */
  preferences?: string[];
  complaints?: string[];
  /** «2 покупки; последняя — …» — контекст для уместного дожима. */
  purchases?: string | null;
  /** «вторник, 14 октября 2026 г., 15:42 (Europe/Moscow)». */
  nowText?: string;
  /** Transcript tail: «Посетитель: …» / «Ассистент: …» */
  dialog: string;
};

function aggressivenessHint(value: number): string {
  if (value <= 20) return 'Настойчивость минимальная: предложи помощь, без призыва к действию.';
  if (value <= 45) return 'Настойчивость умеренная: один мягкий призыв к действию.';
  if (value <= 70) return 'Настойчивость выше средней: веди к цели и предложи следующий шаг.';
  return 'Настойчивость высокая: предложи конкретный следующий шаг (оформление, контакт). Без упрёков и давления.';
}

export async function generateNudgeText(context: NudgeContext): Promise<string> {
  const fallback = nudgeFallbackText(context.attempt);
  try {
    const goal = goalLabelText(context.settings);
    const instructions = [
      'Ты — продавец-консультант интернет-магазина. Посетитель молчит после ответа — напиши ему короткое сообщение-дожим.',
      'Составь ОДНО сообщение: не более 2 предложений, по-русски, без markdown, без приветствия целиком (диалог уже идёт).',
      nudgeRule(context.attempt),
      goal ? `Цель диалога: ${goal}.` : 'Цели нет — просто помоги продолжить диалог.',
      aggressivenessHint(effectiveAggressiveness(context.settings)),
      ...personalityRules(context.settings),
      'Правила: не повторяй дословно свои прошлые сообщения; не выдумывай факты, скидки и обещания; не упрекай посетителя за молчание; не извиняйся дважды.',
      'Верни ТОЛЬКО текст сообщения.',
    ].join('\n');

    const card = {
      name: context.visitor.name,
      contacts: context.visitor.contacts,
      preferences: context.preferences ?? [],
      complaints: context.complaints ?? [],
      purchases: context.purchases ?? null,
      notes: context.visitor.digest.slice(0, 400),
    };

    const result = await generateText({
      model: resolveModel('deepseek:deepseek-flash'),
      instructions,
      messages: [
        {
          role: 'user',
          content: `${context.nowText ? `Сейчас: ${context.nowText}.\n` : ''}Карточка посетителя: ${JSON.stringify(card)}\nСтадия: ${context.stage}\n\nДиалог (фрагмент):\n${context.dialog}`,
        },
      ],
      temperature: 0.6,
      maxOutputTokens: 200,
      providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
      abortSignal: AbortSignal.timeout(20_000),
    });

    return sanitizeNudgeText(result.text ?? '') ?? fallback;
  } catch (err) {
    console.warn('[nudge] generation failed:', err);
    return fallback;
  }
}
