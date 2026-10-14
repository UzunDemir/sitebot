/**
 * Дни рождения (sql/0004_card.sql): храним день/месяц/год отдельными колонками,
 * чтобы день-без-года жил спокойно (29 февраля и т.п.).
 *
 * Вход (стратег / админка): «05.03», «5 марта», «05.03.1990», ISO «1990-03-05».
 * Канон для интерфейсов стратега: «DD.MM» / «DD.MM.YYYY».
 * Отображение: «5 марта» / «5 марта 1990».
 */

export type Birthday = { day: number; month: number; year: number | null };

const RU_MONTHS_INPUT: Record<string, number> = {
  январь: 1,
  января: 1,
  февраль: 2,
  февраля: 2,
  март: 3,
  марта: 3,
  апрель: 4,
  апреля: 4,
  май: 5,
  мая: 5,
  июнь: 6,
  июня: 6,
  июль: 7,
  июля: 7,
  август: 8,
  августа: 8,
  сентябрь: 9,
  сентября: 9,
  октябрь: 10,
  октября: 10,
  ноябрь: 11,
  ноября: 11,
  декабрь: 12,
  декабря: 12,
};

const RU_MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

export function isValidDay(day: number, month: number, year: number | null): boolean {
  if (!Number.isInteger(day) || !Number.isInteger(month)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2100)) return false;
  // Последний день месяца; без года — «щедрый» високосный 2000-й (29 февраля ок).
  const max = new Date(Date.UTC(year ?? 2000, month, 0)).getUTCDate();
  return day <= max;
}

export function makeBirthday(
  day?: number | null,
  month?: number | null,
  year?: number | null,
): Birthday | null {
  const d = day ?? null;
  const m = month ?? null;
  const y = year ?? null;
  if (d === null || m === null) return null;
  if (!isValidDay(d, m, y)) return null;
  return { day: d, month: m, year: y };
}

export function parseBirthday(text: string): Birthday | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // ISO «1990-03-05»
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (match) return makeBirthday(Number(match[3]), Number(match[2]), Number(match[1]));

  // «05.03» / «05.03.1990» (точка, слеш или тире)
  match = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{4}))?$/.exec(trimmed);
  if (match) return makeBirthday(Number(match[1]), Number(match[2]), match[3] ? Number(match[3]) : null);

  // «5 марта» / «5 марта 1990»
  match = /^(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?$/i.exec(trimmed);
  if (match) {
    const month = RU_MONTHS_INPUT[match[2].toLowerCase()];
    if (month) return makeBirthday(Number(match[1]), month, match[3] ? Number(match[3]) : null);
  }

  return null;
}

export function serializeBirthday(birthday: Birthday): string {
  const dd = String(birthday.day).padStart(2, '0');
  const mm = String(birthday.month).padStart(2, '0');
  return birthday.year === null ? `${dd}.${mm}` : `${dd}.${mm}.${birthday.year}`;
}

export function formatBirthday(birthday: Birthday | null | undefined): string | null {
  if (!birthday) return null;
  const month = RU_MONTHS_GENITIVE[birthday.month - 1] ?? '';
  return birthday.year === null ? `${birthday.day} ${month}` : `${birthday.day} ${month} ${birthday.year}`;
}

/** Локальные день и месяц в таймзоне посетителя. */
export function localDayMonth(
  timeZone: string,
  now: Date,
): { day: number; month: number } | null {
  if (!timeZone) return null;
  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
    }).format(now);
    const match = /^(\d{2})\/(\d{2})$/.exec(formatted);
    if (!match) return null;
    return { day: Number(match[1]), month: Number(match[2]) };
  } catch {
    return null;
  }
}

export function isBirthdayToday(birthday: Birthday, timeZone: string, now: Date): boolean {
  const parts = localDayMonth(timeZone, now);
  if (!parts) return false;
  return parts.day === birthday.day && parts.month === birthday.month;
}
