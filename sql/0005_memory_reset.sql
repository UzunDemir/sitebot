-- sitebot 0005: «память никогда не удаляется» — эпохи «забывания».
-- Кнопка/просьба «Забыть меня» больше НЕ удаляет данные: она ставит маркер
-- (эпоху). Активная память бота начинается заново — контекст модели и дожим
-- видят только сообщения после последнего маркера; всё, что было раньше,
-- остаётся в архиве (беседы, события, покупки) для анализа владельцем.
-- revoked_at — владелец вернул эпоху в активную память (карточка посетителя,
-- хронология при этом не меняется).
--
-- Run once in the Supabase SQL Editor, after sql/0004_card.sql.
-- Additive: без миграции приложение работает как раньше (активное окно
-- отключается — таблицы нет, фильтр не применяется).
--
-- Access model matches 0001: RLS enabled, no anon/authenticated policies —
-- only the service role (server-side) reads and writes this table.

create table if not exists memory_resets (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references bots(id) on delete cascade,
  visitor_id uuid not null references visitors(id) on delete cascade,
  -- button — кнопка «Забыть меня» в виджете; chat — текстовая просьба в
  -- диалоге; admin — сброс/возврат из админки.
  source text not null default 'button' check (source in ('button', 'chat', 'admin')),
  reason text not null default '',
  note text not null default '',
  -- Снимок активных полей карточки на момент сброса (имя, контакты, дайджест,
  -- ДР, предпочтения, претензии, интересы) — эпоха остаётся в архиве.
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- Владелец вернул эпоху в активную память: маркер перестаёт «резать» окно.
  revoked_at timestamptz
);

create index if not exists memory_resets_visitor_idx
  on memory_resets (visitor_id, created_at desc);

comment on table memory_resets is
  'Эпохи «забывания»: маркеры сброса активной памяти посетителя. Память не удаляется — предыдущие эпохи остаются в архиве.';

alter table memory_resets enable row level security;

-- ============================================================ verification
select 'sitebot schema v5 installed' as result,
       (select count(*) from pg_tables where tablename = 'memory_resets') as memory_resets_table;
