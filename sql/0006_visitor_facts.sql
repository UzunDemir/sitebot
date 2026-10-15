-- sitebot 0006: структурированные факты посетителя.
-- Каждый факт из пайплайна стратега (имя, контакт, интерес, предпочтение,
-- претензия, ДР, заметка) хранится отдельной строкой kind+value. Повторный
-- факт увеличивает times_seen и обновляет last_seen — это «сырьё» карточки,
-- ленты эпох и анализа (память никогда не удаляется).
--
-- Run once in the Supabase SQL Editor, after sql/0005_memory_reset.sql.
-- Additive: без миграции приложение работает как раньше (факты не собираются).
--
-- Access model matches 0001: RLS enabled, no anon/authenticated policies —
-- only the service role (server-side) reads and writes this table.

create table if not exists visitor_facts (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references bots(id) on delete cascade,
  visitor_id uuid not null references visitors(id) on delete cascade,
  kind text not null default 'fact'
    check (kind in ('name', 'contact', 'interest', 'preference', 'complaint', 'birthday', 'fact')),
  value text not null,
  -- chat — извлечено из диалога; owner — добавлено владельцем; system — служебное.
  source text not null default 'chat' check (source in ('chat', 'owner', 'system')),
  times_seen int not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  unique (visitor_id, kind, value)
);

create index if not exists visitor_facts_visitor_idx
  on visitor_facts (visitor_id, kind, last_seen desc);
create index if not exists visitor_facts_bot_idx
  on visitor_facts (bot_id, kind, last_seen desc);

comment on table visitor_facts is
  'Структурированные факты посетителя: kind+value, счётчик и даты. Память не удаляется.';

alter table visitor_facts enable row level security;

-- ============================================================ verification
select 'sitebot schema v6 installed' as result,
       (select count(*) from pg_tables where tablename = 'visitor_facts') as visitor_facts_table;
