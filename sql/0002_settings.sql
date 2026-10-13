-- sitebot 0002: behavior settings (logic layer) for bots.
-- Run once in the Supabase SQL Editor. The application works without it
-- (defaults are applied in code), but saving logic settings needs the column.

alter table bots
  add column if not exists settings jsonb not null default '{}'::jsonb;

comment on column bots.settings is
  'Behavior settings: maxOutputTokens, showSources, historyDepth, chattiness, goal, goalText, salesPressure';
