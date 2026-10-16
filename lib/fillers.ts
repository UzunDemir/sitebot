/**
 * Быстрые реплики (каскад ответа): мгновенный «отклик» и реплика «долгий
 * поиск» находятся по категории вопроса в подготовленном наборе — без вызова
 * модели. Сначала идёт сид-набор из коробки (ниже), владелец дополняет его
 * в админке. Выбор: категория → тон (негатив = эмпатийный) → ротация → общий
 * фолбэк. Модуль чистый — покрыт тестами smoke-local.
 */

export type FillerKind = 'ack' | 'slow';
export type FillerTone = 'neutral' | 'empathetic';

export type FillerRow = {
  id: string;
  kind: FillerKind;
  tone: FillerTone;
  category: string;
  text: string;
  enabled: boolean;
};

export type FillerPick = {
  text: string;
  kind: FillerKind;
  category: string;
  /** kb — из набора; fallback — встроенная общая реплика. */
  source: 'kb' | 'fallback';
};

export const GENERIC_CATEGORY = 'generic';

/** Категории: ключи для матчинга и подписи для админки. */
export const FILLER_CATEGORIES: Array<{ id: string; label: string; keywords: RegExp }> = [
  {
    id: 'delivery',
    label: 'Доставка и сроки',
    keywords: /(доставк|курьер|сдэк|почт|посылк|привез|прийд|придёт|придет|отправ|трек|срок)/i,
  },
  {
    id: 'payment',
    label: 'Оплата',
    keywords: /(оплат|плат[её]ж|плат[иы]ть|карт[аеой]|рассрочк|счёт|счет|наличн|перевод)/i,
  },
  { id: 'return', label: 'Возврат и обмен', keywords: /(возврат|обмен|вернуть|верну|отказ)/i },
  {
    id: 'availability',
    label: 'Наличие и размеры',
    keywords: /(наличи|остатк|склад|размер|подойдёт|подойдет)/i,
  },
  { id: 'price', label: 'Цена и скидки', keywords: /(цен[аыуе]|стоит|стоимост|скидк|дорог|дешевл)/i },
  { id: 'warranty', label: 'Гарантия и сервис', keywords: /(гарант|ремонт|поломк|сервисн)/i },
  { id: 'order', label: 'Заказ и оформление', keywords: /(заказ|оформл|корзин|покупк)/i },
];

export const FILLER_CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  FILLER_CATEGORIES.map((category) => [category.id, category.label]),
);

/** Категория вопроса по ключевым словам (generic — если не уверены). */
export function categorizeQuestion(question: string): string {
  const text = question.toLowerCase();
  for (const category of FILLER_CATEGORIES) {
    if (category.keywords.test(text)) return category.id;
  }
  return GENERIC_CATEGORY;
}

/** Сид-набор из коробки: заливается боту автоматически (идемпотентно). */
export const SEED_FILLERS: Array<Omit<FillerRow, 'id' | 'enabled'>> = [
  // --- отклик, обычный тон
  { kind: 'ack', tone: 'neutral', category: 'delivery', text: 'Секунду — проверяю условия доставки.' },
  { kind: 'ack', tone: 'neutral', category: 'delivery', text: 'Смотрю сроки и способы доставки.' },
  { kind: 'ack', tone: 'neutral', category: 'payment', text: 'Уточняю варианты оплаты, секунду.' },
  { kind: 'ack', tone: 'neutral', category: 'return', text: 'Проверяю правила возврата и обмена.' },
  { kind: 'ack', tone: 'neutral', category: 'availability', text: 'Смотрю наличие и размеры.' },
  { kind: 'ack', tone: 'neutral', category: 'availability', text: 'Уточняю остатки на складе, секунду.' },
  { kind: 'ack', tone: 'neutral', category: 'price', text: 'Сверяю цены и условия, секунду.' },
  { kind: 'ack', tone: 'neutral', category: 'warranty', text: 'Уточняю условия гарантии.' },
  { kind: 'ack', tone: 'neutral', category: 'order', text: 'Проверяю детали заказа.' },
  { kind: 'ack', tone: 'neutral', category: 'generic', text: 'Секунду, уточняю по базе.' },
  { kind: 'ack', tone: 'neutral', category: 'generic', text: 'Сейчас посмотрю и вернусь с ответом.' },
  // --- отклик, эмпатийный тон (претензии/негатив)
  {
    kind: 'ack',
    tone: 'empathetic',
    category: 'delivery',
    text: 'Понимаю — проверяю, что с вашей доставкой.',
  },
  { kind: 'ack', tone: 'empathetic', category: 'order', text: 'Понимаю, разбираюсь с заказом — уже смотрю.' },
  { kind: 'ack', tone: 'empathetic', category: 'generic', text: 'Понимаю, разбираюсь — секунду.' },
  // --- долгий поиск, обычный тон
  {
    kind: 'slow',
    tone: 'neutral',
    category: 'delivery',
    text: 'Тема объёмная — поднимаю детали по доставке, ещё пара секунд.',
  },
  {
    kind: 'slow',
    tone: 'neutral',
    category: 'availability',
    text: 'Уточняю остатки на складе, ещё мгновение.',
  },
  {
    kind: 'slow',
    tone: 'neutral',
    category: 'generic',
    text: 'Тема объёмная — поднимаю детали, ещё пара секунд.',
  },
  { kind: 'slow', tone: 'neutral', category: 'generic', text: 'Почти готово — ещё несколько секунд.' },
  // --- долгий поиск, эмпатийный тон
  {
    kind: 'slow',
    tone: 'empathetic',
    category: 'generic',
    text: 'Разбираюсь в ситуации, ещё несколько секунд.',
  },
];

/** Встроенный фолбэк, если набора нет (миграция не применена или пусто).
 *  Ротируется, чтобы отклик не повторялся слово в слово. */
export const FALLBACK_FILLER_VARIANTS: Record<FillerKind, string[]> = {
  ack: ['Секунду, уточняю по базе.', 'Минуту — уже смотрю по базе.', 'Секунду, проверяю детали.'],
  slow: [
    'Тема объёмная — поднимаю детали, ещё пара секунд.',
    'Почти готово — ещё несколько секунд.',
    'Нужна пара секунд, чтобы всё уточнить.',
  ],
};

/** Пул кандидатов: категория+тон → категория+нейтральный → общие. */
function candidates(
  fillers: FillerRow[],
  kind: FillerKind,
  tone: FillerTone,
  category: string,
): FillerRow[] {
  const of = (candidateKind: FillerKind, candidateTone: FillerTone, candidateCategory: string) =>
    fillers.filter(
      (row) =>
        row.enabled &&
        row.kind === candidateKind &&
        row.tone === candidateTone &&
        row.category === candidateCategory,
    );

  const chain: Array<[string, FillerTone]> = [
    [category, tone],
    [category, 'neutral'],
    [GENERIC_CATEGORY, tone],
    [GENERIC_CATEGORY, 'neutral'],
  ];

  const seen = new Set<string>();
  const pool: FillerRow[] = [];
  for (const [chainCategory, chainTone] of chain) {
    for (const row of of(kind, chainTone, chainCategory)) {
      if (seen.has(row.text)) continue;
      seen.add(row.text);
      pool.push(row);
    }
  }
  return pool;
}

/** Выбор реплики: категория + тон + ротация (не повторять недавние тексты). */
export function pickFiller(input: {
  question: string;
  kind: FillerKind;
  negative: boolean;
  fillers: FillerRow[];
  recentlyUsed?: string[];
}): FillerPick {
  const category = categorizeQuestion(input.question);
  const tone: FillerTone = input.negative ? 'empathetic' : 'neutral';
  const pool = candidates(input.fillers, input.kind, tone, category);
  if (pool.length === 0) {
    const variants = FALLBACK_FILLER_VARIANTS[input.kind];
    const recent = new Set(input.recentlyUsed ?? []);
    const fresh = variants.filter((variant) => !recent.has(variant));
    return {
      text: (fresh.length > 0 ? fresh : variants)[0],
      kind: input.kind,
      category,
      source: 'fallback',
    };
  }
  const recent = new Set(input.recentlyUsed ?? []);
  const fresh = pool.filter((row) => !recent.has(row.text));
  const chosen = (fresh.length > 0 ? fresh : pool)[0];
  return { text: chosen.text, kind: input.kind, category, source: 'kb' };
}

/** Санитайз текста реплики: одна строка, лимит длины. */
export function sanitizeFillerText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}
