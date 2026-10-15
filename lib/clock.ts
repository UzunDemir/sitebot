/**
 * Текущее время для промптов и детерминированных ответов.
 *
 * Бот должен «осознавать» дату и время: сроки, приветствия по времени дня,
 * поздравления. Таймзону присылает виджет (Intl.DateTimeFormat()
 * .resolvedOptions().timeZone); при пустой/неизвестной — серверное время (UTC).
 *
 * На вопросы «который час / какой сегодня день» сервер отвечает САМ
 * (isTimeOrDateQuestion + buildNowAnswer): модель в грязной истории может
 * повторить устаревшее время из прошлых реплик — код не может.
 */

export type NowInfo = {
  /** «вторник, 14 октября 2026 г., 15:42 (Europe/Moscow)» — для промпта. */
  text: string;
  timeZone: string;
  /** «15:42». */
  time: string;
  /** «вторник, 14 октября 2026 г.». */
  date: string;
};

export function resolveTimeZone(timeZone: string | undefined | null): string {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return 'UTC';
  }
}

export function describeNow(timeZone: string | undefined | null, now: Date = new Date()): NowInfo {
  const tz = resolveTimeZone(timeZone);
  const date = new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  return { text: `${date}, ${time} (${tz})`, timeZone: tz, time, date };
}

/* ---------------------------------------------------------------- */
/* Распознавание вопросов «который час / какой сегодня день»        */
/* ---------------------------------------------------------------- */

/** Нижний регистр, ё→е, лишние знаки убраны, вводные слова срезаны. */
export function normalizeMetaQuestion(text: string): string {
  let s = text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s?:!.(),«»-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const fillers =
    /^(а|и|ну|да|ой|ээ|подскажите|подскажи|скажите|скажи|извините|можно|пожалуйста|все-таки|и все-таки|все же|и все же)[\s,]+/;
  for (let i = 0; i < 4; i += 1) {
    if (!fillers.test(s)) break;
    s = s.replace(fillers, '').trim();
  }
  return s.replace(/^(пожалуйста|плиз)[\s,]+/, '').trim();
}

function isTimeQuestion(text: string): boolean {
  const s = normalizeMetaQuestion(text);
  return (
    /^котор(ый|ое)\s+(сейчас\s+)?час\s*[?!.]*$/.test(s) ||
    /^сколько\s+(сейчас\s+)?врем(я|ени)(\s+(сейчас|на\s+часах|у\s+вас))?(\s+на\s+самом\s+деле)?\s*[?!.]*$/.test(s) ||
    /^врем(я|ени)\s+сейчас\s*[?!.]*$/.test(s) ||
    /^время\s*[?!.]*$/.test(s) ||
    /^текущее\s+время\s*[?!.]*$/.test(s)
  );
}

function isDateQuestion(text: string): boolean {
  const s = normalizeMetaQuestion(text);
  return (
    /^(какой|какое|какая)\s+(сегодня\s+)?(день(\s+недели)?|число|дата)\s*[?!.]*$/.test(s) ||
    /^(какой|какое|какая)\s+(день(\s+недели)?|число|дата)\s+сегодня\s*[?!.]*$/.test(s) ||
    /^(какое|какой)\s+сегодня\s+(день|число|дата)(\s+и\s+время)?\s*[?!.]*$/.test(s) ||
    /^сегодня\s+(какой|какое)\s+(день(\s+недели)?|число|дата)\s*[?!.]*$/.test(s) ||
    /^(какой|какое)\s+сейчас\s+(день|число|дата)\s*[?!.]*$/.test(s)
  );
}

/** Вопрос о текущих дате/времени — отвечаем детерминированно, без модели. */
export function isTimeOrDateQuestion(text: string): boolean {
  return isTimeQuestion(text) || isDateQuestion(text);
}

/** Точный ответ о времени: считает сервер, повторить устаревшее невозможно. */
export function buildNowAnswer(info: NowInfo): string {
  return `Сейчас ${info.time}, ${info.date} (часовой пояс: ${info.timeZone}). Если нужна помощь по магазину — я на связи.`;
}
