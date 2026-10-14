-- sitebot 0004: карточка+ — дата рождения, предпочтения, претензии, покупки.
-- Run once in the Supabase SQL Editor, after sql/0003_seller.sql.
-- Additive: without it the app keeps working (the new fields are simply
-- not collected, and the admin panel shows a migration hint).

-- ============================================================ visitors +
alter table visitors
  add column if not exists birthday_day int check (birthday_day between 1 and 31);
alter table visitors
  add column if not exists birthday_month int check (birthday_month between 1 and 12);
alter table visitors
  add column if not exists birthday_year int check (birthday_year between 1900 and 2100);

alter table visitors
  add column if not exists preferences text[] not null default '{}';
alter table visitors
  add column if not exists complaints text[] not null default '{}';

comment on column visitors.birthday_day is
  'День рождения: число (1-31). Год может быть неизвестен — birthday_year null.';
comment on column visitors.preferences is
  'Предпочтения посетителя (стиль, размер, бюджет…): авто-извлечение + правка владельца.';
comment on column visitors.complaints is
  'Претензии/проблемы, о которых сообщил посетитель.';

-- ============================================================ purchases
-- Сделки посетителя. Сейчас наполняется вручную из карточки в админке;
-- история уходит в промпт («бот знает, что уже куплено») и в метрики.
create table if not exists purchases (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references bots(id) on delete cascade,
  visitor_id uuid not null references visitors(id) on delete cascade,
  title text not null,
  amount numeric(12, 2),
  currency text not null default 'RUB',
  status text not null default 'completed'
    check (status in ('pending', 'completed', 'canceled', 'refunded')),
  ordered_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists purchases_visitor_idx
  on purchases (visitor_id, ordered_at desc);
create index if not exists purchases_bot_idx
  on purchases (bot_id, ordered_at desc);

alter table purchases enable row level security;

-- ============================================================ verification
select 'sitebot schema v4 installed' as result,
       (select count(*) from information_schema.columns
          where table_name = 'visitors'
            and column_name in ('birthday_day', 'birthday_month', 'birthday_year', 'preferences', 'complaints')
       ) as visitor_columns,
       (select count(*) from pg_tables where tablename = 'purchases') as purchases_table;
