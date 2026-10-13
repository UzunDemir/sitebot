/**
 * Behavior settings (the "logic" layer): stored in bots.settings (jsonb),
 * sanitized here, applied by the chat route and the prompt builder.
 *
 * The settings column arrives with sql/0002_settings.sql; until then the
 * code runs on defaults (isMissingColumnError detects the old schema).
 */

export type BotChattiness = 'strict' | 'friendly' | 'proactive' | 'initiator';
export type BotGoal = 'none' | 'call' | 'purchase' | 'phone' | 'birthday' | 'custom';

export type BotSettings = {
  /** Max answer length in tokens (120..2400). */
  maxOutputTokens?: number;
  /** Show source citations and [n] markers in answers. Default: true. */
  showSources?: boolean;
  /** How many recent chat messages go to the model. 0 = full history (0..50). */
  historyDepth?: number;
  /** Conversation style. */
  chattiness?: BotChattiness;
  /** Conversation goal the bot gently drives towards. */
  goal?: BotGoal;
  /** Free-form goal description (goal === 'custom', <= 200 chars). */
  goalText?: string;
  /** Sales pressure: 0 off, 1 moderate, 2 active (with hard guardrails). */
  salesPressure?: 0 | 1 | 2;
};

export const BOT_SETTINGS_DEFAULTS = {
  maxOutputTokens: 600,
  showSources: true,
  historyDepth: 40,
  chattiness: 'friendly' as BotChattiness,
  goal: 'none' as BotGoal,
  goalText: '',
  salesPressure: 0 as 0 | 1 | 2,
};

const CHATTINESS_VALUES: BotChattiness[] = ['strict', 'friendly', 'proactive', 'initiator'];
const GOAL_VALUES: BotGoal[] = ['none', 'call', 'purchase', 'phone', 'birthday', 'custom'];

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

  return out;
}

/** True when a PostgREST error means the settings column does not exist yet. */
export function isMissingColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === '42703') return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /column .*settings.* does not exist/i.test(message);
}
