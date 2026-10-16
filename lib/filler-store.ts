/**
 * Хранилище быстрых реплик (sql/0008): чтение, автосид базового набора,
 * операции для админки. Best-effort: без миграции всё возвращает [] —
 * каскад в этом случае отвечает встроенным фолбэком (lib/fillers.ts).
 */

import { getSupabase } from './supabase';
import { isMissingRelationError } from './visitors';
import {
  SEED_FILLERS,
  sanitizeFillerText,
  type FillerKind,
  type FillerRow,
  type FillerTone,
} from './fillers';

const COLUMNS = 'id, kind, tone, category, text, enabled';

function parseRow(row: Record<string, unknown>): FillerRow {
  return {
    id: String(row.id),
    kind: row.kind === 'slow' ? 'slow' : 'ack',
    tone: row.tone === 'empathetic' ? 'empathetic' : 'neutral',
    category: typeof row.category === 'string' && row.category ? row.category : 'generic',
    text: typeof row.text === 'string' ? row.text : '',
    enabled: row.enabled !== false,
  };
}

async function listRows(botId: string): Promise<FillerRow[] | null> {
  const supabase = getSupabase();
  const res = await supabase.from('bot_fillers').select(COLUMNS).eq('bot_id', botId);
  if (res.error) {
    if (!isMissingRelationError(res.error)) {
      console.warn('[fillers] load failed:', res.error.message);
    }
    return null;
  }
  return (res.data ?? [])
    .map((row) => parseRow(row as Record<string, unknown>))
    .filter((row) => row.text);
}

/** Список реплик бота; при пустой таблице — автосид базового набора. */
export async function loadBotFillers(botId: string): Promise<FillerRow[]> {
  try {
    const rows = await listRows(botId);
    if (rows === null) return [];
    if (rows.length > 0) return rows;
    await seedBotFillers(botId);
    return (await listRows(botId)) ?? [];
  } catch (err) {
    console.warn('[fillers] load error:', err);
    return [];
  }
}

/** Залить сид-набор (идемпотентно: дубликаты игнорируются). Возвращает true при успехе. */
export async function seedBotFillers(botId: string): Promise<boolean> {
  try {
    const supabase = getSupabase();
    const payload = SEED_FILLERS.map((seed) => ({
      bot_id: botId,
      kind: seed.kind,
      tone: seed.tone,
      category: seed.category,
      text: sanitizeFillerText(seed.text),
      enabled: true,
    }));
    const res = await supabase
      .from('bot_fillers')
      .upsert(payload, { onConflict: 'bot_id,kind,tone,category,text', ignoreDuplicates: true });
    if (res.error) {
      if (!isMissingRelationError(res.error)) console.warn('[fillers] seed failed:', res.error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[fillers] seed error:', err);
    return false;
  }
}

/** Добавить реплику (дубликат игнорируется). */
export async function addFiller(
  botId: string,
  input: { kind: FillerKind; tone: FillerTone; category: string; text: string },
): Promise<boolean> {
  try {
    const text = sanitizeFillerText(input.text);
    if (!text) return false;
    const supabase = getSupabase();
    const res = await supabase
      .from('bot_fillers')
      .upsert(
        {
          bot_id: botId,
          kind: input.kind,
          tone: input.tone,
          category: input.category,
          text,
          enabled: true,
        },
        { onConflict: 'bot_id,kind,tone,category,text', ignoreDuplicates: true },
      );
    if (res.error) {
      if (!isMissingRelationError(res.error)) console.warn('[fillers] add failed:', res.error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[fillers] add error:', err);
    return false;
  }
}

export async function setFillerEnabled(botId: string, fillerId: string, enabled: boolean): Promise<boolean> {
  try {
    const supabase = getSupabase();
    const res = await supabase
      .from('bot_fillers')
      .update({ enabled })
      .eq('id', fillerId)
      .eq('bot_id', botId);
    if (res.error) {
      if (!isMissingRelationError(res.error)) console.warn('[fillers] toggle failed:', res.error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[fillers] toggle error:', err);
    return false;
  }
}

export async function deleteFiller(botId: string, fillerId: string): Promise<boolean> {
  try {
    const supabase = getSupabase();
    const res = await supabase.from('bot_fillers').delete().eq('id', fillerId).eq('bot_id', botId);
    if (res.error) {
      if (!isMissingRelationError(res.error)) console.warn('[fillers] delete failed:', res.error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[fillers] delete error:', err);
    return false;
  }
}
