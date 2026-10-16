/**
 * Widget theme: the single sanitizer/normalizer for bots.theme.
 * Used by the admin PATCH route; the normalized object is stored as jsonb
 * and flows to the chat page, /embed and the loader via /api/bot.
 *
 * Everything is optional. Invalid values are silently dropped (the admin
 * form shows the normalized result after saving).
 */

export type WidgetColors = {
  headerBg?: string;
  headerText?: string;
  botBubbleBg?: string;
  botBubbleText?: string;
  userBubbleBg?: string;
  userBubbleText?: string;
  pageBg?: string;
  inputBg?: string;
  /** Цвет точек «бот печатает» (по умолчанию — серый). */
  typingDots?: string;
};

export type WidgetProactive = {
  enabled?: boolean;
  /** 3..60 seconds after page load. */
  delaySeconds?: number;
  /** Teaser text (<= 160 chars). */
  text?: string;
};

export type WidgetTheme = {
  /** Primary color: user bubbles, buttons, avatar background (#RRGGBB). */
  accent?: string;
  /** Launcher bubble color on the host site (#RRGGBB). */
  bubbleColor?: string;
  /** Launcher content: short emoji/text (<= 8 chars) or an image URL (https / data:image). */
  bubbleIcon?: string;
  /** Header avatar image (https:// or data:image/...). */
  avatarUrl?: string;
  /** Widget header title (defaults to the bot name). */
  title?: string;
  /** Widget header subtitle. */
  subtitle?: string;
  /** CSS font-family value, e.g. "Inter, system-ui, sans-serif". */
  fontFamily?: string;
  /** Optional https stylesheet URL to load a web font (e.g. Google Fonts). */
  fontUrl?: string;
  /** Launcher side on the host site. */
  position?: 'left' | 'right';
  /** Launcher diameter in px (48..80). */
  launcherSize?: number;
  /** Optional visible text next to the launcher. */
  launcherLabel?: string;
  /** Horizontal offset from the chosen side, px (0..300). */
  offsetX?: number;
  /** Vertical offset from the bottom, px (0..300). */
  offsetY?: number;
  /** Launcher opacity (0.4..1). */
  opacity?: number;
  /** Shadow strength for launcher and window. */
  shadow?: 'none' | 'soft' | 'medium' | 'strong';
  /** Entrance/exit animation. */
  animationIn?: 'none' | 'fade' | 'slide' | 'pop';
  /** Chat window width in px (320..560). */
  windowWidth?: number;
  /** Chat window height in px (400..820). */
  windowHeight?: number;
  /** Corner radius in px (0..28). */
  radius?: number;
  /** Dark color scheme for the chat (explicit colors win). */
  dark?: boolean;
  /** Слово перед точками «бот печатает» (до 24 символов; пусто = «Печатает»). */
  typingLabel?: string;
  /** Анимация точек: jump — прыгают, run — бегут слева направо. */
  typingDotsMode?: 'jump' | 'run';
  /** Точки «бот печатает»: размер точки, px (3..10). */
  typingDotsSize?: number;
  /** Прыжок точек, px (1..10). */
  typingDotsJump?: number;
  /** Скорость цикла анимации точек, мс (300..3000). */
  typingDotsSpeed?: number;
  /** Fine-grained palette overrides. */
  colors?: WidgetColors;
  /** Proactive teaser message near the launcher. */
  proactive?: WidgetProactive;
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const SAFE_FONT = /^[a-zA-Z0-9\s,'"-]+$/;

const COLOR_KEYS: Array<keyof WidgetColors> = [
  'headerBg',
  'headerText',
  'botBubbleBg',
  'botBubbleText',
  'userBubbleBg',
  'userBubbleText',
  'pageBg',
  'inputBg',
  'typingDots',
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function str(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function color(value: unknown): string | undefined {
  const candidate = str(value, 7);
  return candidate && HEX.test(candidate) ? candidate : undefined;
}

function url(value: unknown, max = 500): string | undefined {
  const candidate = str(value, max);
  if (!candidate) return undefined;
  if (/^data:image\//.test(candidate)) return candidate;
  if (/^https:\/\//.test(candidate)) return candidate;
  return undefined;
}

function intInRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function colors(input: unknown): WidgetColors | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const out: WidgetColors = {};
  for (const key of COLOR_KEYS) {
    const candidate = color(raw[key]);
    if (candidate) out[key] = candidate;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function proactive(input: unknown): WidgetProactive | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  if (raw.enabled !== true) return undefined;
  const text = str(raw.text, 160);
  const delay = intInRange(raw.delaySeconds, 3, 60);
  return {
    enabled: true,
    delaySeconds: delay ?? 8,
    ...(text ? { text } : {}),
  };
}

export function parseWidgetTheme(input: unknown): WidgetTheme {
  if (!input || typeof input !== 'object') return {};
  const raw = input as Record<string, unknown>;
  const theme: WidgetTheme = {};

  theme.accent = color(raw.accent);
  theme.bubbleColor = color(raw.bubbleColor);

  const icon = str(raw.bubbleIcon, 200_000);
  if (icon) {
    theme.bubbleIcon = url(icon, 200_000) ?? icon.slice(0, 8);
  }

  theme.avatarUrl = url(raw.avatarUrl, 200_000);
  theme.title = str(raw.title, 60);
  theme.subtitle = str(raw.subtitle, 80);

  const font = str(raw.fontFamily, 120);
  theme.fontFamily = font && SAFE_FONT.test(font) ? font : undefined;
  theme.fontUrl = url(raw.fontUrl);

  if (raw.position === 'left' || raw.position === 'right') {
    theme.position = raw.position;
  }
  theme.launcherSize = intInRange(raw.launcherSize, 48, 80);
  theme.launcherLabel = str(raw.launcherLabel, 40);
  theme.offsetX = intInRange(raw.offsetX, 0, 300);
  theme.offsetY = intInRange(raw.offsetY, 0, 300);
  if (typeof raw.opacity === 'number' && Number.isFinite(raw.opacity)) {
    theme.opacity = Math.round(clamp(raw.opacity, 0.4, 1) * 100) / 100;
  }
  if (raw.shadow === 'none' || raw.shadow === 'soft' || raw.shadow === 'medium' || raw.shadow === 'strong') {
    theme.shadow = raw.shadow;
  }
  if (raw.animationIn === 'none' || raw.animationIn === 'fade' || raw.animationIn === 'slide' || raw.animationIn === 'pop') {
    theme.animationIn = raw.animationIn;
  }
  theme.windowWidth = intInRange(raw.windowWidth, 320, 560);
  theme.windowHeight = intInRange(raw.windowHeight, 400, 820);
  theme.radius = intInRange(raw.radius, 0, 28);
  if (raw.dark === true) theme.dark = true;
  theme.typingLabel = str(raw.typingLabel, 24);
  if (raw.typingDotsMode === 'jump' || raw.typingDotsMode === 'run') {
    theme.typingDotsMode = raw.typingDotsMode;
  }
  theme.typingDotsSize = intInRange(raw.typingDotsSize, 3, 10);
  theme.typingDotsJump = intInRange(raw.typingDotsJump, 1, 10);
  theme.typingDotsSpeed = intInRange(raw.typingDotsSpeed, 300, 3000);

  theme.colors = colors(raw.colors);
  theme.proactive = proactive(raw.proactive);

  return theme;
}
