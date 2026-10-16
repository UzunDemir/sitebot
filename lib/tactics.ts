/**
 * Тактики продаж (стратег 2.0): сервер детерминированно выбирает тактику на
 * ответ — из пула, разрешённого стадией диалога, шкалами (агрессивность,
 * хитрость) и целью. Тактика задаёт формулировку шага к цели («выбор из двух»,
 * «сначала ценность»...); модель не выбирает приёмы сама, а применяет заданный.
 * Прошлая тактика не повторяется дважды подряд — ротация.
 *
 * Контексты, где тактики выключены: негатив/отказ (сначала помощь), CTA
 * подавлены (кулдаун), цель не задана, агрессивность ≤20 («без давления»).
 */

import { BOT_SETTINGS_DEFAULTS, effectiveAggressiveness, type BotSettings } from './bot-settings';

export type TacticId =
  | 'preempt-objection'
  | 'choice-close'
  | 'question-close'
  | 'ask-permission'
  | 'soft-handoff'
  | 'value-first';

export type Tactic = {
  id: TacticId;
  title: string;
  /** Готовая строка для блока «Режим ответа» (lib/style.ts). */
  line: string;
  /** Стадии диалога, где тактика уместна (см. STAGES). */
  stages: string[];
  minCunning?: number;
  minAggression?: number;
  maxAggression?: number;
};

/** Порядок массива = приоритет внутри подходящего пула. */
export const TACTICS: Tactic[] = [
  {
    id: 'preempt-objection',
    title: 'Предвосхитить возражение',
    line: 'Тактика «предвосхищение»: одной фразой заранее сними вероятное возражение (цена, срок, доверие), затем шаг к цели.',
    stages: ['offer', 'objections'],
    minCunning: 55,
  },
  {
    id: 'choice-close',
    title: 'Выбор из двух',
    line: 'Тактика «выбор из двух»: предложи два конкретных варианта следующего шага («перезвоню в 15:00 или 18:00?»).',
    stages: ['close', 'followup'],
    minCunning: 35,
    minAggression: 35,
  },
  {
    id: 'question-close',
    title: 'Вопрос-закрытие',
    line: 'Тактика «вопрос-закрытие»: заверши вопросом, который двигает к цели, а не утверждением.',
    stages: ['qualification', 'offer', 'close'],
    minCunning: 15,
  },
  {
    id: 'ask-permission',
    title: 'Спросить разрешение',
    line: 'Тактика «разрешение»: сначала спроси, можно ли предложить следующий шаг («подсказать, как удобнее?»), и только потом предлагай.',
    stages: ['qualification', 'objections'],
    maxAggression: 60,
  },
  {
    id: 'soft-handoff',
    title: 'Честная передача менеджеру',
    line: 'Тактика «передача»: если решение не в твоей компетенции — честно предложи передать вопрос менеджеру или уточнить и вернуться, без давления.',
    stages: ['objections', 'close', 'followup'],
    maxAggression: 75,
  },
  {
    id: 'value-first',
    title: 'Сначала ценность',
    line: 'Тактика «сначала ценность»: сначала дай пользу (решение, факт, выгоду), затем один мягкий шаг к цели.',
    stages: ['greeting', 'qualification', 'offer', 'objections', 'close', 'followup'],
  },
];

export type TacticContext = {
  stage: string;
  lastTactic: string | null;
  negative: boolean;
  /** CTA подавлены (негатив/отказ/кулдаун) — тактики не применяются. */
  suppressed: boolean;
};

/** Детерминированный выбор тактики на текущий ответ (или null). */
export function pickTactic(settings: BotSettings, ctx: TacticContext): Tactic | null {
  if (ctx.negative || ctx.suppressed) return null;
  if ((settings.goal ?? 'none') === 'none') return null;

  const aggression = effectiveAggressiveness(settings);
  if (aggression <= 20) return null; // «без давления» — без продающих приёмов

  const cunning = settings.cunning ?? BOT_SETTINGS_DEFAULTS.cunning;
  const pool = TACTICS.filter(
    (tactic) =>
      tactic.stages.includes(ctx.stage) &&
      (tactic.minCunning ?? 0) <= cunning &&
      (tactic.minAggression ?? 0) <= aggression &&
      (tactic.maxAggression ?? 100) >= aggression,
  );
  if (pool.length === 0) return null;

  const rotated = pool.filter((tactic) => tactic.id !== ctx.lastTactic);
  return (rotated.length > 0 ? rotated : pool)[0];
}
