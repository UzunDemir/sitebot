/**
 * Behavior settings (the "logic" layer): stored in bots.settings (jsonb),
 * sanitized here, applied by the chat route, the prompt builder and the
 * nudge engine.
 *
 * The settings column arrives with sql/0002_settings.sql; until then the
 * code runs on defaults (isMissingColumnError detects the old schema).
 */

import { KNOWLEDGE_PACK_IDS } from './knowledge-packs';

export type BotChattiness = 'strict' | 'friendly' | 'proactive' | 'initiator';

/** 10 goal presets (+ none / custom). «Достигнуто» judges the strategist. */
export type BotGoal =
  | 'none'
  | 'phone'
  | 'messenger'
  | 'call'
  | 'booking'
  | 'demo'
  | 'purchase'
  | 'order'
  | 'quote'
  | 'review'
  | 'birthday'
  | 'custom';

export type BotNudges = {
  /** Max touches in a row (0..5). */
  attempts?: number;
  /** Silence before touch #1, seconds (15..600). */
  firstDelaySec?: number;
  /** Gap before touch #2; grows ×2 per further touch (60..86400). */
  intervalSec?: number;
};

export type BotQuietHours = {
  enabled?: boolean;
  /** "HH:MM" local (visitor timezone). */
  from?: string;
  /** "HH:MM" local — the bot stays silent until this time. */
  to?: string;
};

export type BotProactiveSettings = {
  enabled?: boolean;
  nudges?: BotNudges;
  quietHours?: BotQuietHours;
};

export type BotSettings = {
  /** Max answer length in tokens (120..2400). */
  maxOutputTokens?: number;
  /** Show source citations and [n] markers in answers. Default: true. */
  showSources?: boolean;
  /** How many recent chat messages go to the model. 0 = full history (0..50). */
  historyDepth?: number;
  /** Conversation style. */
  chattiness?: BotChattiness;
  /** Conversation goal the bot drives towards. */
  goal?: BotGoal;
  /** Free-form goal description (goal === 'custom', <= 200 chars). */
  goalText?: string;
  /** Legacy sales pressure (0|1|2); mapped to aggressiveness 0/50/80. */
  salesPressure?: 0 | 1 | 2;
  /** Sales aggressiveness 0..100 (step 5). */
  aggressiveness?: number;
  /** Tone 0..100 (0 friendly ↔ 100 formal); 50 = neutral. */
  tone?: number;
  /** Юмор 0..100: 0 — строго по делу, 100 — тепло и с шутками (без сарказма). */
  humor?: number;
  /** Хитрость 0..100: изобретательные приёмы убеждения; обман запрещён. */
  cunning?: number;
  /** Остроумие 0..100: неожиданные, меткие формулировки. */
  wit?: number;
  /** Эмпатия 0..100: 0 — деловой тон, 100 — сначала признать чувства клиента. */
  empathy?: number;
  /** Каскад ответа (sql/0008): мгновенный отклик и реплика «долгий поиск». */
  fastAck?: boolean;
  slowNotice?: boolean;
  /** Порог второго пузыря, мс (2000..15000). */
  slowNoticeAfterMs?: number;
  /** Наборы знаний (Ф7): id из lib/knowledge-packs.ts (до 8). */
  packs?: string[];
  /** Свои знания/указания владельца (до 2000 символов). */
  customKnowledge?: string;
  /** Proactive touches: nudge engine + quiet hours (Ф3). */
  proactive?: BotProactiveSettings;
};

export const BOT_SETTINGS_DEFAULTS = {
  maxOutputTokens: 600,
  showSources: true,
  historyDepth: 40,
  chattiness: 'friendly' as BotChattiness,
  goal: 'none' as BotGoal,
  goalText: '',
  salesPressure: 0 as 0 | 1 | 2,
  aggressiveness: 40,
  tone: 50,
  humor: 30,
  cunning: 40,
  wit: 30,
  empathy: 50,
  fastAck: true,
  slowNotice: true,
  slowNoticeAfterMs: 4000,
  packs: [] as string[],
  customKnowledge: '',
  proactive: {
    enabled: true,
    nudges: { attempts: 2, firstDelaySec: 45, intervalSec: 300 },
    quietHours: { enabled: false, from: '21:00', to: '09:00' },
  },
};

const CHATTINESS_VALUES: BotChattiness[] = ['strict', 'friendly', 'proactive', 'initiator'];
const GOAL_VALUES: BotGoal[] = [
  'none',
  'phone',
  'messenger',
  'call',
  'booking',
  'demo',
  'purchase',
  'order',
  'quote',
  'review',
  'birthday',
  'custom',
];

const HHMM = /^\d{1,2}:\d{2}$/;

function intInRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function parseBotSettings(input: unknown): BotSettings {
  if (!input || typeof input !== 'object') return {};
  const raw = input as Record<string, unknown>;
  const out: BotSettings = {};

  out.maxOutputTokens = intInRange(raw.maxOutputTokens, 120, 2400);
  if (typeof raw.showSources === 'boolean') out.showSources = raw.showSources;
  out.historyDepth = intInRange(raw.historyDepth, 0, 50);

  if (typeof raw.chattiness === 'string' && CHATTINESS_VALUES.includes(raw.chattiness as BotChattiness)) {
    out.chattiness = raw.chattiness as BotChattiness;
  }
  if (typeof raw.goal === 'string' && GOAL_VALUES.includes(raw.goal as BotGoal)) {
    out.goal = raw.goal as BotGoal;
  }
  if (typeof raw.goalText === 'string' && raw.goalText.trim()) {
    out.goalText = raw.goalText.trim().slice(0, 200);
  }
  if (raw.salesPressure === 0 || raw.salesPressure === 1 || raw.salesPressure === 2) {
    out.salesPressure = raw.salesPressure;
  }
  out.aggressiveness = intInRange(raw.aggressiveness, 0, 100);
  out.tone = intInRange(raw.tone, 0, 100);
  out.humor = intInRange(raw.humor, 0, 100);
  out.cunning = intInRange(raw.cunning, 0, 100);
  out.wit = intInRange(raw.wit, 0, 100);
  out.empathy = intInRange(raw.empathy, 0, 100);

  // Наборы знаний (Ф7): только известные id, без дублей, до 8 штук.
  if (Array.isArray(raw.packs)) {
    const seen = new Set<string>();
    const packs: string[] = [];
    for (const id of raw.packs) {
      if (typeof id !== 'string') continue;
      const clean = id.trim();
      if (!KNOWLEDGE_PACK_IDS.has(clean) || seen.has(clean)) continue;
      seen.add(clean);
      packs.push(clean);
      if (packs.length >= 8) break;
    }
    out.packs = packs;
  }
  if (typeof raw.customKnowledge === 'string' && raw.customKnowledge.trim()) {
    out.customKnowledge = raw.customKnowledge.trim().slice(0, 2000);
  }
  if (typeof raw.fastAck === 'boolean') out.fastAck = raw.fastAck;
  if (typeof raw.slowNotice === 'boolean') out.slowNotice = raw.slowNotice;
  out.slowNoticeAfterMs = intInRange(raw.slowNoticeAfterMs, 2000, 15000);

  if (raw.proactive && typeof raw.proactive === 'object' && !Array.isArray(raw.proactive)) {
    const p = raw.proactive as Record<string, unknown>;
    const proactive: BotProactiveSettings = {};
    if (typeof p.enabled === 'boolean') proactive.enabled = p.enabled;

    if (p.nudges && typeof p.nudges === 'object' && !Array.isArray(p.nudges)) {
      const n = p.nudges as Record<string, unknown>;
      const nudges: BotNudges = {};
      const attempts = intInRange(n.attempts, 0, 5);
      if (attempts !== undefined) nudges.attempts = attempts;
      const first = intInRange(n.firstDelaySec, 15, 600);
      if (first !== undefined) nudges.firstDelaySec = first;
      const interval = intInRange(n.intervalSec, 60, 86400);
      if (interval !== undefined) nudges.intervalSec = interval;
      proactive.nudges = nudges;
    }

    if (p.quietHours && typeof p.quietHours === 'object' && !Array.isArray(p.quietHours)) {
      const q = p.quietHours as Record<string, unknown>;
      const quietHours: BotQuietHours = {};
      if (typeof q.enabled === 'boolean') quietHours.enabled = q.enabled;
      if (typeof q.from === 'string' && HHMM.test(q.from.trim())) quietHours.from = q.from.trim();
      if (typeof q.to === 'string' && HHMM.test(q.to.trim())) quietHours.to = q.to.trim();
      proactive.quietHours = quietHours;
    }

    out.proactive = proactive;
  }

  return out;
}

/** Sales aggressiveness with the legacy salesPressure mapping. */
export function effectiveAggressiveness(settings: BotSettings): number {
  if (typeof settings.aggressiveness === 'number') return settings.aggressiveness;
  if (settings.salesPressure === 1) return 50;
  if (settings.salesPressure === 2) return 80;
  if (settings.salesPressure === 0) return 0;
  return BOT_SETTINGS_DEFAULTS.aggressiveness;
}

/** Fully resolved proactive config (settings layered over defaults). */
export type EffectiveProactive = {
  enabled: boolean;
  attempts: number;
  firstDelaySec: number;
  intervalSec: number;
  quietHours: { enabled: boolean; from: string; to: string };
};

export function effectiveProactive(settings: BotSettings): EffectiveProactive {
  const d = BOT_SETTINGS_DEFAULTS.proactive;
  const p = settings.proactive ?? {};
  return {
    enabled: p.enabled ?? d.enabled,
    attempts: p.nudges?.attempts ?? d.nudges.attempts,
    firstDelaySec: p.nudges?.firstDelaySec ?? d.nudges.firstDelaySec,
    intervalSec: p.nudges?.intervalSec ?? d.nudges.intervalSec,
    quietHours: {
      enabled: p.quietHours?.enabled ?? d.quietHours.enabled,
      from: p.quietHours?.from ?? d.quietHours.from,
      to: p.quietHours?.to ?? d.quietHours.to,
    },
  };
}

/** True when a PostgREST error means a column does not exist yet (old schema). */
export function isMissingColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === '42703') return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /column .* does not exist/i.test(message);
}
