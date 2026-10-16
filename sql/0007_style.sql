-- sitebot 0007: шкалы характера — реальная механика (CTA-бюджет, отказы, кулдаун).
-- Счётчики и «остывание» живут в беседе:
--   cta_sent      — сколько ответов с предложением следующего шага (CTA) отправлено
--   phone_asked   — сколько раз бот просил контакт/звонок (бюджет просьб)
--   refusals      — явные отказы клиента («не звоните», «не надо»)
--   silenced_until — кулдаун продаж после отказов: CTA и дожим выключены до времени
--   style_flags   — последние пост-проверки стиля (для корректировки следующего ответа)
--
-- Run once in the Supabase SQL Editor, after sql/0006_visitor_facts.sql.
-- Additive: без миграции механика шкал деградирует до промпт-правил
-- (счётчики не ведутся, кулдаун не ставится).

alter table conversations add column if not exists cta_sent int not null default 0;
alter table conversations add column if not exists phone_asked int not null default 0;
alter table conversations add column if not exists refusals int not null default 0;
alter table conversations add column if not exists silenced_until timestamptz;
alter table conversations add column if not exists style_flags jsonb not null default '{}'::jsonb;

comment on column conversations.cta_sent is
  'Ответы с предложением следующего шага (CTA). Бюджет ведёт сервер, не модель.';
comment on column conversations.silenced_until is
  'Кулдаун продаж после отказов: CTA и дожим выключены до этого времени.';

-- ============================================================ verification
select 'sitebot schema v7 installed' as result,
       (select count(*) from information_schema.columns
         where table_name = 'conversations'
           and column_name in ('cta_sent', 'phone_asked', 'refusals', 'silenced_until', 'style_flags')) as style_columns;
