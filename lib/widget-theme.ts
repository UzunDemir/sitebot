/**
 * Widget theme: the single sanitizer/normalizer for bots.theme.
 * Used by the admin PATCH route; the normalized object is stored as jsonb
 * and flows to the chat page, /embed and the loader via /api/bot.
 *
 * Everything is optional. Invalid values are silently dropped (the admin
 * form shows the normalized result after saving).
 */

export type WidgetTheme = {
  /** Primary color: user bubbles, buttons, avatar background (#RRGGBB). */
  accent?: string;
  /** Launcher bubble color on the host site (#RRGGBB). */
  bubbleColor?: string;
  /** Launcher content: short emoji/text (<= 8 chars) or an image URL. */
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
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const SAFE_FONT = /^[a-zA-Z0-9\s,'"-]+$/;

function str(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function color(value: unknown): string | undefined {
  const candidate = str(value, 7);
  return candidate && HEX.test(candidate) ? candidate : undefined;
}

function url(value: unknown): string | undefined {
  const candidate = str(value, 500);
  if (!candidate) return undefined;
  if (/^data:image\//.test(candidate) || /^https:\/\//.test(candidate)) return candidate;
  return undefined;
}

export function parseWidgetTheme(input: unknown): WidgetTheme {
  if (!input || typeof input !== 'object') return {};
  const raw = input as Record<string, unknown>;
  const theme: WidgetTheme = {};

  theme.accent = color(raw.accent);
  theme.bubbleColor = color(raw.bubbleColor);

  const icon = str(raw.bubbleIcon, 500);
  if (icon) {
    theme.bubbleIcon = url(icon) ?? icon.slice(0, 8);
  }

  theme.avatarUrl = url(raw.avatarUrl);
  theme.title = str(raw.title, 60);
  theme.subtitle = str(raw.subtitle, 80);

  const font = str(raw.fontFamily, 120);
  theme.fontFamily = font && SAFE_FONT.test(font) ? font : undefined;
  theme.fontUrl = url(raw.fontUrl);

  return theme;
}
