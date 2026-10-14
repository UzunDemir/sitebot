/**
 * Текущее время для промптов: «вторник, 14 октября 2026 г., 15:42 (Europe/Moscow)».
 *
 * Бот должен «осознавать» дату и время: сроки, приветствия по времени дня,
 * поздравления. Таймзону присылает виджет (Intl.DateTimeFormat().resolvedOptions()
 * .timeZone); при пустой/неизвестной — серверное время (UTC).
 */

export type NowInfo = { text: string; timeZone: string };

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
  const dateText = new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);
  const timeText = new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  return { text: `${dateText}, ${timeText} (${tz})`, timeZone: tz };
}
