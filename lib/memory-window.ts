/**
 * Память-эпохи («память никогда не удаляется», решение 15.10.2026).
 *
 * Кнопка «Забыть меня» и текстовая просьба «забудь» больше ничего не удаляют:
 * они ставят маркер в `memory_resets` (sql/0005_memory_reset.sql). Активная
 * память бота — всё, что после последнего не отозванного маркера. Более
 * раннее — архив: беседы, события и покупки остаются у владельца навсегда
 * (профиль, анализ, стратегии). Маркер можно отозвать (revoked_at) — владелец
 * возвращает эпоху в активную память, хронология при этом не меняется.
 *
 * Best-effort и schema-aware: без миграции 0005 все хелперы деградируют к
 * «эпох нет» (getActiveSince → null = фильтр не применяется).
 */

import { getSupabase } from './supabase';
import {
  getVisitorById,
  isMissingRelationError,
  loadVisitorByKey,
  recordEvent,
  updateVisitorProfile,
  type VisitorProfilePatch,
  type VisitorRow,
} from './visitors';

export type MemoryResetSource = 'button' | 'chat' | 'admin';

export type MemoryResetRow = {
  id: string;
  source: string;
  reason: string;
  note: string;
  snapshot: Record<string, unknown>;
  createdAt: string;
  revokedAt: string | null;
};

/** Снимок активных полей карточки — уходит в архив эпохи при сбросе. */
export function memorySnapshot(visitor: VisitorRow): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  if (visitor.name) snapshot.name = visitor.name;
  if (Object.keys(visitor.contacts).length > 0) snapshot.contacts = visitor.contacts;
  if (visitor.memory_digest) snapshot.digest = visitor.memory_digest;
  if (visitor.birthday_day || visitor.birthday_month || visitor.birthday_year) {
    snapshot.birthday = {
      day: visitor.birthday_day,
      month: visitor.birthday_month,
      year: visitor.birthday_year,
    };
  }
  if (visitor.preferences.length > 0) snapshot.preferences = visitor.preferences;
  if (visitor.complaints.length > 0) snapshot.complaints = visitor.complaints;
  const interests = Array.isArray(visitor.meta.interests) ? visitor.meta.interests : [];
  if (interests.length > 0) snapshot.interests = interests;
  return snapshot;
}

/** Одна эпоха сброса. null — миграция 0005 не применена (best effort). */
export async function createMemoryReset(input: {
  botId: string;
  visitorId: string;
  source: MemoryResetSource;
  reason?: string;
  note?: string;
  snapshot?: Record<string, unknown>;
}): Promise<string | null> {
  try {
    const supabase = getSupabase();
    const res = await supabase
      .from('memory_resets')
      .insert({
        bot_id: input.botId,
        visitor_id: input.visitorId,
        source: input.source,
        reason: input.reason ?? '',
        note: input.note ?? '',
        snapshot: input.snapshot ?? {},
      })
      .select('id')
      .single();
    if (res.error) {
      if (!isMissingRelationError(res.error)) {
        console.warn('[memory] reset insert failed:', res.error.message);
      }
      return null;
    }
    return (res.data?.id as string | undefined) ?? null;
  } catch (err) {
    console.warn('[memory] reset insert error:', err);
    return null;
  }
}

/**
 * Граница активной памяти: последний не отозванный сброс посетителя.
 * Сообщения, покупки и события раньше этой границы — архив: модель и дожим
 * их не видят. null = эпох нет (ничего не сбрасывалось).
 */
export async function getActiveSince(visitorId: string): Promise<Date | null> {
  try {
    const supabase = getSupabase();
    const res = await supabase
      .from('memory_resets')
      .select('created_at')
      .eq('visitor_id', visitorId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (res.error) {
      if (!isMissingRelationError(res.error)) {
        console.warn('[memory] active window failed:', res.error.message);
      }
      return null;
    }
    const iso = (res.data?.created_at as string | undefined) ?? null;
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch (err) {
    console.warn('[memory] active window error:', err);
    return null;
  }
}

/** Все эпохи посетителя, новые сверху (хронология в админке — Ф6). */
export async function listMemoryResets(visitorId: string): Promise<MemoryResetRow[]> {
  try {
    const supabase = getSupabase();
    const res = await supabase
      .from('memory_resets')
      .select('id, source, reason, note, snapshot, created_at, revoked_at')
      .eq('visitor_id', visitorId)
      .order('created_at', { ascending: false });
    if (res.error) {
      if (!isMissingRelationError(res.error)) {
        console.warn('[memory] list failed:', res.error.message);
      }
      return [];
    }
    return (res.data ?? []).map((row) => ({
      id: String((row as { id: unknown }).id),
      source: String((row as { source?: unknown }).source ?? ''),
      reason:
        typeof (row as { reason?: unknown }).reason === 'string'
          ? ((row as { reason: string }).reason)
          : '',
      note:
        typeof (row as { note?: unknown }).note === 'string'
          ? ((row as { note: string }).note)
          : '',
      snapshot:
        (row as { snapshot?: unknown }).snapshot &&
        typeof (row as { snapshot: unknown }).snapshot === 'object' &&
        !Array.isArray((row as { snapshot: unknown }).snapshot)
          ? ((row as { snapshot: Record<string, unknown> }).snapshot)
          : {},
      createdAt:
        typeof (row as { created_at?: unknown }).created_at === 'string'
          ? ((row as { created_at: string }).created_at)
          : '',
      revokedAt:
        typeof (row as { revoked_at?: unknown }).revoked_at === 'string'
          ? ((row as { revoked_at: string }).revoked_at)
          : null,
    }));
  } catch (err) {
    console.warn('[memory] list error:', err);
    return [];
  }
}

/** Владелец возвращает эпоху в активную память (Ф6): маркер перестаёт резать окно. */
export async function revokeMemoryReset(resetId: string): Promise<boolean> {
  try {
    const supabase = getSupabase();
    const res = await supabase
      .from('memory_resets')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', resetId);
    if (res.error) {
      if (!isMissingRelationError(res.error)) {
        console.warn('[memory] revoke failed:', res.error.message);
      }
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[memory] revoke error:', err);
    return false;
  }
}

/**
 * «Забыть меня»: новая эпоха. Снимок карточки уходит в архив; активная память
 * (имя, контакты, дайджест, ДР, предпочтения, претензии, интересы) обнуляется;
 * беседы глушатся до первого сообщения новой эпохи (оживит chat-роут).
 * Ничего не удаляется — это и есть симуляция забывания.
 */
export async function softResetVisitor(input: {
  botId: string;
  visitorKey: string;
  source: MemoryResetSource;
  sessionKey?: string;
  reason?: string;
}): Promise<{ ok: boolean; visitorId: string | null }> {
  try {
    const supabase = getSupabase();
    const visitor = await loadVisitorByKey(input.botId, input.visitorKey);

    if (!visitor) {
      // Карточки ещё нет (совсем новый посетитель) — сбрасывать нечего, но
      // текущую беседу всё равно закрываем для дожима (best effort).
      if (input.sessionKey) {
        const upd = await supabase
          .from('conversations')
          .update({ outcome: 'memory_reset', nudges_sent: 0 })
          .eq('bot_id', input.botId)
          .eq('session_key', input.sessionKey)
          .neq('outcome', 'stopped');
        if (upd.error && !isMissingRelationError(upd.error)) {
          console.warn('[memory] reset conversation failed:', upd.error.message);
        }
      }
      return { ok: true, visitorId: null };
    }

    const snapshot = memorySnapshot(visitor);
    const resetId = await createMemoryReset({
      botId: input.botId,
      visitorId: visitor.id,
      source: input.source,
      reason: input.reason ?? '',
      snapshot,
    });

    // Активная память обнуляется — архив остаётся.
    const patch: VisitorProfilePatch = {
      name: null,
      contacts: {},
      memory_digest: '',
      meta: { ...visitor.meta, interests: [] },
    };
    if (visitor.schema_v4) {
      patch.birthday_day = null;
      patch.birthday_month = null;
      patch.birthday_year = null;
      patch.preferences = [];
      patch.complaints = [];
    }
    await updateVisitorProfile(visitor.id, patch);

    // Глушим дожим во всех беседах посетителя до первого сообщения новой
    // эпохи; стоп-слово (outcome=stopped) не трогаем — это глухой стоп.
    const convs = await supabase
      .from('conversations')
      .update({ outcome: 'memory_reset', nudges_sent: 0 })
      .eq('visitor_id', visitor.id)
      .neq('outcome', 'stopped');
    if (convs.error && !isMissingRelationError(convs.error)) {
      console.warn('[memory] reset conversations failed:', convs.error.message);
    }
    if (input.sessionKey) {
      const conv = await supabase
        .from('conversations')
        .update({ outcome: 'memory_reset', nudges_sent: 0 })
        .eq('bot_id', input.botId)
        .eq('session_key', input.sessionKey)
        .neq('outcome', 'stopped');
      if (conv.error && !isMissingRelationError(conv.error)) {
        console.warn('[memory] reset session conversation failed:', conv.error.message);
      }
    }

    await recordEvent({
      botId: input.botId,
      visitorId: visitor.id,
      type: 'memory_reset',
      payload: { source: input.source, resetId: resetId ?? null, fields: Object.keys(snapshot) },
    });

    return { ok: true, visitorId: visitor.id };
  } catch (err) {
    console.warn('[memory] soft reset error:', err);
    return { ok: false, visitorId: null };
  }
}

/** Одна эпоха с идентификаторами (админка: проверка принадлежности). */
export type MemoryResetFull = MemoryResetRow & { visitorId: string; botId: string };

export async function getMemoryResetById(resetId: string): Promise<MemoryResetFull | null> {
  try {
    const supabase = getSupabase();
    const res = await supabase
      .from('memory_resets')
      .select('id, bot_id, visitor_id, source, reason, note, snapshot, created_at, revoked_at')
      .eq('id', resetId)
      .maybeSingle();
    if (res.error) {
      if (!isMissingRelationError(res.error)) {
        console.warn('[memory] reset load failed:', res.error.message);
      }
      return null;
    }
    const row = res.data as Record<string, unknown> | null;
    if (!row) return null;
    return {
      id: String(row.id),
      visitorId: String(row.visitor_id),
      botId: String(row.bot_id),
      source: String(row.source ?? ''),
      reason: typeof row.reason === 'string' ? row.reason : '',
      note: typeof row.note === 'string' ? row.note : '',
      snapshot:
        row.snapshot && typeof row.snapshot === 'object' && !Array.isArray(row.snapshot)
          ? (row.snapshot as Record<string, unknown>)
          : {},
      createdAt: typeof row.created_at === 'string' ? row.created_at : '',
      revokedAt: typeof row.revoked_at === 'string' ? row.revoked_at : null,
    };
  } catch (err) {
    console.warn('[memory] reset load error:', err);
    return null;
  }
}

/** «Вернуть в активную» / «скрыть обратно»: маркер перестаёт/снова режет окно. */
export async function setMemoryResetRevoked(resetId: string, revoked: boolean): Promise<boolean> {
  try {
    const supabase = getSupabase();
    const res = await supabase
      .from('memory_resets')
      .update({ revoked_at: revoked ? new Date().toISOString() : null })
      .eq('id', resetId);
    if (res.error) {
      if (!isMissingRelationError(res.error)) {
        console.warn('[memory] revoke failed:', res.error.message);
      }
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[memory] revoke error:', err);
    return false;
  }
}

/**
 * Вернуть снимок эпохи в карточку (Ф6): только в ПУСТЫЕ поля — правки
 * владельца и более новые факты не перезаписываются. Хронология не меняется.
 */
export async function restoreMemorySnapshot(
  visitorId: string,
  snapshot: Record<string, unknown>,
  fields?: string[],
): Promise<boolean> {
  try {
    const visitor = await getVisitorById(visitorId);
    if (!visitor) return false;

    // fields (Ф6, точечный возврат): если задан — восстанавливаем только эти поля.
    const allowed = fields && fields.length > 0 ? new Set(fields) : null;
    const ok = (key: string): boolean => !allowed || allowed.has(key);

    const patch: VisitorProfilePatch = {};
    const str = (value: unknown): string | null =>
      typeof value === 'string' && value.trim() ? value.trim() : null;

    const snapshotName = str(snapshot.name);
    if (ok('name') && !visitor.name && snapshotName) patch.name = snapshotName;

    if (
      ok('contacts') &&
      Object.keys(visitor.contacts).length === 0 &&
      snapshot.contacts &&
      typeof snapshot.contacts === 'object' &&
      !Array.isArray(snapshot.contacts)
    ) {
      patch.contacts = snapshot.contacts as Record<string, string>;
    }
    const snapshotDigest = str(snapshot.digest);
    if (ok('digest') && !visitor.memory_digest && snapshotDigest) patch.memory_digest = snapshotDigest;

    const interests = Array.isArray(snapshot.interests)
      ? snapshot.interests.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const currentInterests = Array.isArray(visitor.meta.interests) ? visitor.meta.interests : [];
    if (ok('interests') && currentInterests.length === 0 && interests.length > 0) {
      patch.meta = { ...visitor.meta, interests };
    }

    if (visitor.schema_v4) {
      const birthday =
        snapshot.birthday && typeof snapshot.birthday === 'object' && !Array.isArray(snapshot.birthday)
          ? (snapshot.birthday as { day?: unknown; month?: unknown; year?: unknown })
          : null;
      if (birthday && ok('birthday')) {
        if (!visitor.birthday_day && typeof birthday.day === 'number') patch.birthday_day = birthday.day;
        if (!visitor.birthday_month && typeof birthday.month === 'number') patch.birthday_month = birthday.month;
        if (!visitor.birthday_year && typeof birthday.year === 'number') patch.birthday_year = birthday.year;
      }
      const preferences = Array.isArray(snapshot.preferences)
        ? snapshot.preferences.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      if (ok('preferences') && visitor.preferences.length === 0 && preferences.length > 0) {
        patch.preferences = preferences;
      }
      const complaints = Array.isArray(snapshot.complaints)
        ? snapshot.complaints.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      if (ok('complaints') && visitor.complaints.length === 0 && complaints.length > 0) {
        patch.complaints = complaints;
      }
    }

    if (Object.keys(patch).length === 0) return true; // восстанавливать нечего — это норма
    return updateVisitorProfile(visitorId, patch);
  } catch (err) {
    console.warn('[memory] snapshot restore error:', err);
    return false;
  }
}

