/**
 * Структурированные факты посетителя (sql/0006_visitor_facts.sql).
 *
 * Пайплайн стратега пишет каждый извлечённый факт отдельной строкой
 * (kind + value): «сырьё» для карточки, ленты эпох и анализа («память
 * никогда не удаляется»). Повторный факт увеличивает times_seen и обновляет
 * last_seen. Текст для промпта по-прежнему собирается из карточки/дайджеста —
 * таблица обслуживает структуру и владельца.
 *
 * Best-effort и schema-aware: без миграции 0006 функции тихо возвращают
 * пустые значения (приложение работает как раньше).
 */

import { getSupabase } from './supabase';
import { isMissingRelationError } from './visitors';
import type { VisitorFacts } from './visitor-memory';
import { formatBirthday } from './birthday';

export type VisitorFactRow = {
  id: string;
  kind: string;
  value: string;
  source: string;
  timesSeen: number;
  firstSeen: string;
  lastSeen: string;
};

const FACT_COLUMNS = 'id, kind, value, source, times_seen, first_seen, last_seen';
const MAX_VALUE = 240;

/** Факты карточки → строки (kind, value). */
export function factsToPairs(facts: VisitorFacts): Array<{ kind: string; value: string }> {
  const pairs: Array<{ kind: string; value: string }> = [];
  if (facts.name) pairs.push({ kind: 'name', value: facts.name });
  for (const [key, value] of Object.entries(facts.contacts ?? {})) {
    if (value) pairs.push({ kind: 'contact', value: `${key}: ${value}` });
  }
  for (const item of facts.interests ?? []) pairs.push({ kind: 'interest', value: item });
  for (const item of facts.preferences ?? []) pairs.push({ kind: 'preference', value: item });
  for (const item of facts.complaints ?? []) pairs.push({ kind: 'complaint', value: item });
  const birthdayText = facts.birthday ? formatBirthday(facts.birthday) : null;
  if (birthdayText) pairs.push({ kind: 'birthday', value: birthdayText });
  if (facts.note) pairs.push({ kind: 'fact', value: facts.note });
  return pairs;
}

/** Записать факты (insert или times_seen+1). Возвращает число сохранённых. */
export async function recordVisitorFacts(input: {
  botId: string;
  visitorId: string;
  facts: VisitorFacts;
  source?: 'chat' | 'owner' | 'system';
}): Promise<number> {
  const pairs = factsToPairs(input.facts);
  if (pairs.length === 0) return 0;
  let saved = 0;
  try {
    const supabase = getSupabase();
    for (const pair of pairs) {
      const value = pair.value.trim().replace(/\s+/g, ' ').slice(0, MAX_VALUE);
      if (!value) continue;
      const existing = await supabase
        .from('visitor_facts')
        .select('id, times_seen')
        .eq('visitor_id', input.visitorId)
        .eq('kind', pair.kind)
        .eq('value', value)
        .maybeSingle();
      if (existing.error) {
        if (!isMissingRelationError(existing.error)) {
          console.warn('[facts] read failed:', existing.error.message);
        }
        return saved;
      }
      if (existing.data) {
        const upd = await supabase
          .from('visitor_facts')
          .update({
            times_seen: (typeof existing.data.times_seen === 'number' ? existing.data.times_seen : 1) + 1,
            last_seen: new Date().toISOString(),
          })
          .eq('id', existing.data.id);
        if (!upd.error) saved += 1;
      } else {
        const ins = await supabase.from('visitor_facts').insert({
          bot_id: input.botId,
          visitor_id: input.visitorId,
          kind: pair.kind,
          value,
          source: input.source ?? 'chat',
        });
        if (ins.error) {
          if (!isMissingRelationError(ins.error)) {
            console.warn('[facts] insert failed:', ins.error.message);
          }
        } else {
          saved += 1;
        }
      }
    }
  } catch (err) {
    console.warn('[facts] record error:', err);
  }
  return saved;
}

/** Все факты посетителя (новые сверху) — карточка в админке и анализ. */
export async function listVisitorFacts(visitorId: string, limit = 100): Promise<VisitorFactRow[]> {
  try {
    const supabase = getSupabase();
    const res = await supabase
      .from('visitor_facts')
      .select(FACT_COLUMNS)
      .eq('visitor_id', visitorId)
      .order('last_seen', { ascending: false })
      .limit(limit);
    if (res.error) {
      if (!isMissingRelationError(res.error)) {
        console.warn('[facts] list failed:', res.error.message);
      }
      return [];
    }
    return (res.data ?? []).map((row) => ({
      id: String((row as { id: unknown }).id),
      kind: String((row as { kind?: unknown }).kind ?? 'fact'),
      value: String((row as { value?: unknown }).value ?? ''),
      source: String((row as { source?: unknown }).source ?? 'chat'),
      timesSeen: typeof (row as { times_seen?: unknown }).times_seen === 'number' ? ((row as { times_seen: number }).times_seen) : 1,
      firstSeen: typeof (row as { first_seen?: unknown }).first_seen === 'string' ? ((row as { first_seen: string }).first_seen) : '',
      lastSeen: typeof (row as { last_seen?: unknown }).last_seen === 'string' ? ((row as { last_seen: string }).last_seen) : '',
    }));
  } catch (err) {
    console.warn('[facts] list error:', err);
    return [];
  }
}
