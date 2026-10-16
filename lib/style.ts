/**
 * Шкалы характера — реальная механика, а не только текст в промпте.
 *
 * resolveStyle() превращает шкалы (агрессивность, тон, юмор, хитрость,
 * остроумие, эмпатия) и контекст (негатив, отказ, кулдаун, счётчики беседы)
 * в конфиг ответа: политику CTA, бюджет просьб о контакте, эмпатию-первой,
 * режим юмора, обращение, параметры генерации. Конфиг применяется трижды:
 * к модели (temperature), к промпту (buildStyleBlock) и к пост-проверкам
 * (styleText, flags). Модуль чистый — без БД, легко тестируется в smoke-local.
 */

import { BOT_SETTINGS_DEFAULTS, effectiveAggressiveness, type BotSettings } from './bot-settings';

/* ---------------------------------------------------------------- */
/* Контекст и конфиг                                                */
/* ---------------------------------------------------------------- */

export type StyleContext = {
  /** Сообщение клиента негативное (жалоба, задержка, возврат…). */
  negative: boolean;
  /** Текущее сообщение — явный отказ. */
  refusal: boolean;
  /** Беседа в кулдауне после отказов (silenced_until > now). */
  silenced: boolean;
  /** Сколько CTA уже отправлено в беседе. */
  ctaSent: number;
  /** Сколько раз уже просили контакт/звонок. */
  phoneAsked: number;
};

export type StyleConfig = {
  /** Температура генерации (учитывает остроумие/хитрость). */
  temperature: number;
  ctaPolicy: 'none' | 'soft' | 'active';
  phoneAskAllowed: boolean;
  empathyFirst: boolean;
  humor: 'off' | 'light' | 'on';
  pronoun: 'вы' | null;
  stripExclamations: boolean;
  stripEmoji: boolean;
};

/** Бюджет просьб о контакте за беседу (даже при агрессивности 100). */
export const PHONE_ASK_BUDGET = 3;
/** После стольких явных отказов продажи «остывают». */
export const REFUSAL_COOLDOWN_COUNT = 2;
/** Длительность кулдауна. */
export const REFUSAL_COOLDOWN_MS = 15 * 60 * 1000;

/* ---------------------------------------------------------------- */
/* Детекторы (чистые эвристики; покрыты тестами smoke-local)        */
/* ---------------------------------------------------------------- */

const NEGATIVE_RE =
  /(не\s+пришл|не\s+привезл|задерж|опозда|просроч|проблем|жалоб|верните|возврат|не\s+работает|сломан|испорт|брак|обман|обманул|ужас|отврат|недовол|разочаров|кошмар|хамств|сколько\s+можно|надоел|бесит|второй\s+раз|третий\s+раз|уже\s+неделю|до\s+сих\s+пор)/i;

/** Негативное сообщение: жалоба, задержка, возврат и т.п. */
export function isNegativeMessage(text: string): boolean {
  return NEGATIVE_RE.test(text);
}

const REFUSAL_RE =
  /(не\s+звоните|не\s+перезвон|не\s+надо|не\s+нужно|не\s+буду|не\s+интересн|больше\s+не\s+пиш|не\s+пишите|отстань|отстаньте|хватит|прекратит|не\s+звони)/i;
// Внимание: \b в JS не работает с кириллицей — границу задаём явным классом.
const SOFT_NO_RE = /^\s*нет(?![а-яёa-z])(?!\s*,?\s*(проблем|вопрос|спасибо,?\s*вс[её]))/i;

/** Явный отказ: просьба не писать/не звонить. «нет проблем» не считается. */
export function isRefusalMessage(text: string): boolean {
  return REFUSAL_RE.test(text) || SOFT_NO_RE.test(text);
}

const CTA_RE =
  /(давайте|оставьте|напишите|укажите|перезвон|позвон|созвон|звоните|пришл[юи]|оформ(лю|ить|им)|забронир|подбер[уеё]|удобно\s+ли|можете\s+оставить|предлагаю|хотите,?\s+я)/i;

/** Есть ли в ответе предложение следующего шага (CTA). */
export function hasCta(text: string): boolean {
  return CTA_RE.test(text);
}

const CONTACT_ASK_RE =
  /(телефон|номер|контакт|whatsapp|ватсап|телеграм|telegram|перезвон|созвон|звонок|позвон|звонк)/i;

/** Просьба оставить контакт/созвониться (для бюджета просьб). */
export function hasContactAsk(text: string): boolean {
  return CONTACT_ASK_RE.test(text);
}

const EMPATHY_RE =
  /(понимаю|сочувствую|представляю|досадно|неприятн|это\s+правда\s+(раздражает|обидно)|справедлив\w*|жаль|согласен|согласна)/i;

/** Признание чувств (первым предложением при эмпатии-первой). */
export function hasEmpathyMarker(text: string): boolean {
  return EMPATHY_RE.test(text);
}

const TY_RE = /(^|[^а-яa-z])(ты|тебя|тебе|твой|твоя|твои|твоё|твое)([^а-яa-z]|$)/i;

/** Обращение на «ты» (проверка при тоне «строго на вы»). */
export function hasTy(text: string): boolean {
  return TY_RE.test(text);
}

const CLICHES = [
  'как я могу вам помочь',
  'чем могу помочь',
  'отличный вопрос',
  'хороший вопрос',
  'спасибо за обращение',
  'ваш вопрос очень важен',
  'я вас услышал',
];

/** Первое найденное клише (или null). */
export function findCliche(text: string): string | null {
  const low = text.toLowerCase();
  return CLICHES.find((cliche) => low.includes(cliche)) ?? null;
}

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2764}]/gu;

/** Есть ли эмодзи (для «юмор выключен»). */
export function hasEmoji(text: string): boolean {
  EMOJI_RE.lastIndex = 0;
  return EMOJI_RE.test(text);
}

/* ---------------------------------------------------------------- */
/* resolveStyle                                                     */
/* ---------------------------------------------------------------- */

/**
 * Шкалы + контекст → конфиг ответа. Приоритеты: негатив и отказ подавляют
 * продажи; кулдаун снимает CTA целиком; бюджет просьб о контакте не
 * превышается даже при агрессивности 100.
 */
export function resolveStyle(
  settings: BotSettings,
  ctx: StyleContext,
  opts: { baseTemperature?: number | null } = {},
): StyleConfig {
  const aggression = effectiveAggressiveness(settings);
  const tone = settings.tone ?? BOT_SETTINGS_DEFAULTS.tone;
  const humor = settings.humor ?? BOT_SETTINGS_DEFAULTS.humor;
  const cunning = settings.cunning ?? BOT_SETTINGS_DEFAULTS.cunning;
  const wit = settings.wit ?? BOT_SETTINGS_DEFAULTS.wit;
  const empathy = settings.empathy ?? BOT_SETTINGS_DEFAULTS.empathy;

  // --- temperature: остроумие/хитрость добавляют «смелости» формулировкам.
  const base =
    typeof opts.baseTemperature === 'number' && Number.isFinite(opts.baseTemperature)
      ? opts.baseTemperature
      : 0.7;
  const temperature = Math.min(
    0.95,
    Math.max(0.2, base + ((wit - 50) / 100) * 0.3 + ((cunning - 50) / 100) * 0.1),
  );

  // --- CTA-политика: негатив/отказ/кулдаун подавляют продажи.
  const suppressed = ctx.negative || ctx.refusal || ctx.silenced;
  const ctaPolicy: StyleConfig['ctaPolicy'] = suppressed
    ? 'none'
    : aggression <= 20
      ? 'none'
      : aggression <= 60
        ? 'soft'
        : 'active';

  const phoneAskAllowed =
    !suppressed && ctaPolicy !== 'none' && ctx.phoneAsked < PHONE_ASK_BUDGET;

  const empathyFirst = ctx.negative && empathy >= 70;

  const humorMode: StyleConfig['humor'] = ctx.negative
    ? 'off'
    : humor <= 20
      ? 'off'
      : humor <= 60
        ? 'light'
        : 'on';

  const pronoun: StyleConfig['pronoun'] = tone >= 50 ? 'вы' : null;

  return {
    temperature,
    ctaPolicy,
    phoneAskAllowed,
    empathyFirst,
    humor: humorMode,
    pronoun,
    stripExclamations: tone >= 70 || humorMode === 'off' || ctx.negative,
    stripEmoji: humorMode === 'off' || tone >= 70,
  };
}

/** Блок промпта: жёсткие правила текущего ответа (приоритетнее общих шкал). */
export function buildStyleBlock(style: StyleConfig, corrective: string[] = []): string | null {
  const lines: string[] = [];

  if (style.ctaPolicy === 'none') {
    lines.push(
      'Предложения следующего шага (контакт, звонок, оформление, «давайте») в этом ответе ЗАПРЕЩЕНЫ — сначала помоги по сути.',
    );
  } else if (style.ctaPolicy === 'soft') {
    lines.push('Можно одно мягкое предложение следующего шага — без давления.');
  } else {
    lines.push('Заверши ответ одним конкретным предложением следующего шага.');
  }
  if (!style.phoneAskAllowed) {
    lines.push('Не проси телефон, номер или звонок в этом ответе.');
  }
  if (style.empathyFirst) {
    lines.push('Первым предложением признай чувства и ситуацию клиента, затем — суть.');
  }
  if (style.humor === 'off') {
    lines.push('Юмор, шутки и эмодзи в этом ответе выключены — тепло, но серьёзно.');
  } else if (style.humor === 'light') {
    lines.push('Без шуток; лёгкая теплота допустима.');
  }
  if (style.pronoun === 'вы') {
    lines.push('Обращение — строго на «вы».');
  }
  lines.push(
    'Избегай шаблонных фраз («чем могу помочь», «отличный вопрос», «спасибо за обращение»); при этом признание чувств, если оно требуется выше, — не шаблон.',
  );
  lines.push('Не повторяй формулировки из своих предыдущих ответов в этом диалоге.');
  if (corrective.length > 0) {
    lines.push(`Замечания к прошлому ответу: ${corrective.join('; ')}.`);
  }

  return `Режим ответа на это сообщение (приоритетно, выше общих шкал):\n- ${lines.join('\n- ')}`;
}

/** Замечания к прошлому ответу по сохранённым флагам (style_flags). */
export function correctiveNotes(prevFlags: unknown): string[] {
  const flags =
    prevFlags && typeof prevFlags === 'object' && Array.isArray((prevFlags as { flags?: unknown }).flags)
      ? ((prevFlags as { flags: unknown[] }).flags.filter((f): f is string => typeof f === 'string'))
      : [];
  const notes: string[] = [];
  if (flags.includes('no_empathy')) notes.push('в прошлом ответе не было признания чувств — начни с него');
  if (flags.includes('no_cta')) notes.push('в прошлом ответе не было следующего шага — добавь его');
  if (flags.includes('cliche')) notes.push('убери шаблонные формулировки');
  if (flags.includes('repeat')) notes.push('не повторяй прежние формулировки');
  if (flags.includes('ty')) notes.push('обращайся на «вы»');
  if (flags.includes('humor_leak')) notes.push('убери шутки и эмодзи');
  return notes.slice(0, 2);
}

/* ---------------------------------------------------------------- */
/* Пост-фильтр текста (применяется и к стриму, и к сохранённому)    */
/* ---------------------------------------------------------------- */

/** Детерминированная чистка: восклицания и эмодзи по режиму стиля. */
export function styleText(text: string, style: Pick<StyleConfig, 'stripExclamations' | 'stripEmoji'>): string {
  let out = text;
  if (style.stripExclamations) out = out.replace(/!{2,}/g, '.');
  if (style.stripEmoji) out = out.replace(EMOJI_RE, '');
  return out;
}

/**
 * Стрим-версия чистки для потока частей AI SDK (TextStreamPart): правит
 * только text-delta, перенося «хвост» (серии «!» и половинки суррогатных пар
 * эмодзи) в следующий чанк. Остальные части пропускает как есть.
 */
export function styleTextStream<T extends { type: string }>(
  stream: ReadableStream<T>,
  style: Pick<StyleConfig, 'stripExclamations' | 'stripEmoji'>,
): ReadableStream<T> {
  if (!style.stripExclamations && !style.stripEmoji) return stream;

  let carry = '';

  const takeCarry = (text: string): string => {
    let combined = carry + text;
    carry = '';
    if (style.stripEmoji) {
      const lastCode = combined.charCodeAt(combined.length - 1);
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
        carry = combined.slice(-1);
        combined = combined.slice(0, -1);
      }
    }
    if (style.stripExclamations) {
      const match = combined.match(/!+$/);
      if (match) {
        carry = match[0] + carry;
        combined = combined.slice(0, -match[0].length);
      }
    }
    return combined;
  };

  const transform = new TransformStream<T, T>({
    transform(part, controller) {
      const record = part as unknown as Record<string, unknown>;
      if (
        record &&
        record.type === 'text-delta' &&
        (typeof record.text === 'string' || typeof record.textDelta === 'string')
      ) {
        const field = typeof record.text === 'string' ? 'text' : 'textDelta';
        const combined = takeCarry(record[field] as string);
        controller.enqueue({
          ...(record as object),
          [field]: styleText(combined, style),
        } as unknown as T);
      } else {
        controller.enqueue(part);
      }
    },
    flush(controller) {
      if (carry) {
        const processed = styleText(carry, style);
        if (processed) {
          controller.enqueue({ type: 'text-delta', text: processed } as unknown as T);
        }
      }
    },
  });

  return stream.pipeThrough(transform);
}
