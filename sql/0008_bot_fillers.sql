-- sitebot 0008: быстрые реплики (каскад ответа) — подготовленный набор.
-- Виджет показывает мгновенный отклик (пузырь 1) до начала ответа модели,
-- а при долгой подготовке — вторую реплику (пузырь «долгий поиск»). Тексты
-- берутся из этого набора по категории вопроса — без вызова модели; модели
-- реплики не касаются (они не сохраняются в историю и в контекст).
--
-- Run once in the Supabase SQL Editor, after sql/0007_style.sql.
-- Additive: без миграции каскад отвечает встроенными фолбэк-репликами.
--
-- Access model matches 0001: RLS enabled, no anon/authenticated policies —
-- only the service role (server-side) reads and writes this table.

create table if not exists bot_fillers (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references bots(id) on delete cascade,
  -- ack — мгновенный отклик; slow — реплика «ответ готовится долго».
  kind text not null default 'ack' check (kind in ('ack', 'slow')),
  -- neutral — обычный тон; empathetic — для претензий/негатива.
  tone text not null default 'neutral' check (tone in ('neutral', 'empathetic')),
  -- Категория вопроса: delivery / payment / return / availability / price /
  -- warranty / order / generic (список — lib/fillers.ts).
  category text not null default 'generic',
  text text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  -- Идемпотентный сид: одинаковые реплики не дублируются.
  unique (bot_id, kind, tone, category, text)
);

create index if not exists bot_fillers_bot_idx on bot_fillers (bot_id, kind) where enabled;

comment on table bot_fillers is
  'Быстрые реплики каскада: мгновенный отклик и «долгий поиск» по категориям вопроса.';

alter table bot_fillers enable row level security;

-- Ротация: какие тексты реплик уже показывали в этой беседе.
alter table conversations add column if not exists last_fillers jsonb not null default '[]'::jsonb;

-- ============================================================ verification
select 'sitebot schema v8 installed' as result,
       (select count(*) from pg_tables where tablename = 'bot_fillers') as bot_fillers_table;
