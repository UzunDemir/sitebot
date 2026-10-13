-- sitebot 0003: «активный продавец», фаза 2 — карточка посетителя.
-- Run once in the Supabase SQL Editor, after sql/0001_init.sql and
-- sql/0002_settings.sql. Additive: until it is applied the application
-- runs on defaults (dialog memory degrades to plain conversation history).
--
-- Access model matches 0001: RLS enabled, no anon/authenticated policies —
-- only the service role (server-side) reads and writes these tables.

-- ============================================================ visitors
create table if not exists visitors (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references bots(id) on delete cascade,
  visitor_key text not null,
  name text,
  contacts jsonb not null default '{}'::jsonb,
  tags text[] not null default '{}',
  notes text not null default '',
  memory_digest text not null default '',
  do_not_disturb boolean not null default false,
  meta jsonb not null default '{}'::jsonb,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  unique (bot_id, visitor_key)
);

create index if not exists visitors_bot_last_seen_idx
  on visitors (bot_id, last_seen desc);

comment on table visitors is
  'Visitor card: identity (visitor_key), extracted facts (name, contacts), owner notes and tags.';

-- ============================================================ events
create table if not exists events (
  id bigserial primary key,
  bot_id uuid not null references bots(id) on delete cascade,
  visitor_id uuid references visitors(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists events_bot_type_created_idx
  on events (bot_id, type, created_at desc);

-- ============================================================ conversations +
-- visitor_id links a dialog to its visitor card; stage/outcome and nudge
-- counters are filled by the seller engine (later phases).
alter table conversations
  add column if not exists visitor_id uuid references visitors(id) on delete set null;
alter table conversations
  add column if not exists stage text not null default 'greeting';
alter table conversations
  add column if not exists outcome text not null default 'in_progress';
alter table conversations
  add column if not exists summary text not null default '';
alter table conversations
  add column if not exists nudges_sent int not null default 0;
alter table conversations
  add column if not exists last_nudge_at timestamptz;

create index if not exists conversations_visitor_idx
  on conversations (visitor_id, last_active_at desc);

-- ============================================================ messages +
-- Marks bot-initiated follow-ups (proactive messages / nudges).
alter table messages
  add column if not exists is_proactive boolean not null default false;
alter table messages
  add column if not exists nudge_number int;

-- ============================================================ RLS
alter table visitors enable row level security;
alter table events enable row level security;

-- ============================================================ verification
select 'sitebot schema v3 installed' as result,
       (select count(*) from pg_tables where tablename in ('visitors', 'events')) as new_tables,
       (select count(*) from information_schema.columns
          where table_name = 'conversations'
            and column_name in ('visitor_id', 'stage', 'outcome', 'summary', 'nudges_sent', 'last_nudge_at')
       ) as conversation_columns,
       (select count(*) from information_schema.columns
          where table_name = 'messages'
            and column_name in ('is_proactive', 'nudge_number')
       ) as message_columns;
