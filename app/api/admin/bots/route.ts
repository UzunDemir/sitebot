/**
 * Admin bots API: list (also serves as a session check) and create.
 */

import { adminGuard } from '@/lib/admin-auth';
import { getSupabase } from '@/lib/supabase';
import { AVAILABLE_MODELS } from '@/lib/models';

const BOT_COLUMNS =
  'id, name, public_key, model_id, system_prompt, greeting, temperature, top_k, thinking_enabled, is_active, theme, allowed_origins, created_at';

const DEFAULT_SYSTEM_PROMPT =
  'Ты — ассистент поддержки. Отвечай на вопросы пользователя, опираясь только на предоставленный контекст, и ссылайся на источники.';

export async function GET(req: Request): Promise<Response> {
  const guard = adminGuard(req);
  if (guard) return guard;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('bots')
    .select(BOT_COLUMNS)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[admin] bots list failed:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }

  return Response.json({ bots: data ?? [], models: AVAILABLE_MODELS });
}

export async function POST(req: Request): Promise<Response> {
  const guard = adminGuard(req);
  if (guard) return guard;

  const body = (await req.json().catch(() => null)) as { name?: string } | null;
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return Response.json({ error: 'bad_name' }, { status: 400 });
  }

  const supabase = getSupabase();
  const ins = await supabase
    .from('bots')
    .insert({
      name: name.slice(0, 80),
      model_id: 'deepseek:deepseek-flash',
      system_prompt: DEFAULT_SYSTEM_PROMPT,
      greeting: 'Здравствуйте! Чем могу помочь?',
      top_k: 6,
      thinking_enabled: false,
      is_active: true,
    })
    .select(BOT_COLUMNS)
    .single();
  if (ins.error) {
    console.error('[admin] bot create failed:', ins.error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }

  return Response.json({ bot: ins.data });
}
