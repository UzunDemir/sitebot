/**
 * Admin bots API: update a single bot's settings
 * (model, prompt, widget theme, origin allowlist).
 */

import { adminGuard } from '@/lib/admin-auth';
import { getSupabase } from '@/lib/supabase';
import { AVAILABLE_MODELS } from '@/lib/models';
import { parseWidgetTheme } from '@/lib/widget-theme';
import { isMissingColumnError, parseBotSettings } from '@/lib/bot-settings';

const MODEL_IDS = new Set(AVAILABLE_MODELS.map((m) => m.id));

const BOT_COLUMNS =
  'id, name, public_key, model_id, system_prompt, greeting, temperature, top_k, thinking_enabled, is_active, theme, allowed_origins, settings, created_at';
const BOT_COLUMNS_LEGACY =
  'id, name, public_key, model_id, system_prompt, greeting, temperature, top_k, thinking_enabled, is_active, theme, allowed_origins, created_at';

function normalizeOrigin(value: string): string | null {
  let candidate = value.trim();
  if (!candidate) return null;
  if (!/^https?:\/\//i.test(candidate)) candidate = 'https://' + candidate;
  try {
    return new URL(candidate).origin;
  } catch {
    return null;
  }
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = adminGuard(req);
  if (guard) return guard;

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
  if (typeof body.greeting === 'string') patch.greeting = body.greeting.slice(0, 500);
  if (typeof body.system_prompt === 'string') patch.system_prompt = body.system_prompt.slice(0, 4000);
  if (typeof body.model_id === 'string') {
    if (!MODEL_IDS.has(body.model_id)) {
      return Response.json({ error: 'unknown_model' }, { status: 400 });
    }
    patch.model_id = body.model_id;
  }
  if (typeof body.top_k === 'number' && Number.isFinite(body.top_k)) {
    patch.top_k = Math.min(10, Math.max(1, Math.round(body.top_k)));
  }
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
    patch.temperature = Math.min(1, Math.max(0, body.temperature));
  }
  if (typeof body.thinking_enabled === 'boolean') patch.thinking_enabled = body.thinking_enabled;
  if (typeof body.is_active === 'boolean') patch.is_active = body.is_active;

  // Widget theme: sanitized and normalized (colors, URLs, font whitelist).
  if (typeof body.theme === 'object' && body.theme !== null) {
    patch.theme = parseWidgetTheme(body.theme);
  }

  // Behavior settings (logic layer), sanitized in one place.
  if (typeof body.settings === 'object' && body.settings !== null) {
    patch.settings = parseBotSettings(body.settings);
  }

  if (typeof body.allowed_origins === 'string') {
    const origins = body.allowed_origins
      .split(/[\n,]+/)
      .map((part) => normalizeOrigin(part))
      .filter((origin): origin is string => Boolean(origin))
      .slice(0, 20);
    patch.allowed_origins = origins;
  }

  if (Object.keys(patch).length === 0) {
    return Response.json({ error: 'nothing_to_update' }, { status: 400 });
  }

  const supabase = getSupabase();
  let upd = await supabase.from('bots').update(patch).eq('id', id).select(BOT_COLUMNS).single();
  if (upd.error && isMissingColumnError(upd.error)) {
    if ('settings' in patch) {
      return Response.json(
        {
          error: 'settings_not_migrated',
          message: 'Настройки логики требуют миграции: выполните sql/0002_settings.sql в Supabase SQL Editor.',
        },
        { status: 422 },
      );
    }
    upd = await supabase.from('bots').update(patch).eq('id', id).select(BOT_COLUMNS_LEGACY).single();
  }
  if (upd.error) {
    console.error('[admin] bot update failed:', upd.error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }

  return Response.json({ bot: upd.data });
}
