# sitebot — встраиваемый RAG-ассистент

Демо-бот: отвечает по вашей базе знаний, стримит ответ и показывает источники.
База знаний заменяется без деплоя (фаза 2 добавит админку; пока — seed-скрипт).

**Стек:** Next.js 16 (App Router, TS, Tailwind 4) · Vercel AI SDK 7 · DeepSeek `deepseek-flash`
· Supabase Postgres + pgvector · эмбеддинги — Google Gemini (бесплатный tier, сменный слой).

## Быстрый старт

1. **Supabase**: создайте проект → SQL Editor → выполните `sql/0001_init.sql`.
2. **Ключи**: скопируйте `.env.example` → `.env.local` и заполните:
   - `SUPABASE_URL` и серверный ключ — Supabase → Connect → Server: в новом дашборде он называется `SUPABASE_SECRET_KEY` (прежнее имя — `service_role`), впишите его в строку `SUPABASE_SERVICE_ROLE_KEY`;
   - `DEEPSEEK_API_KEY` — platform.deepseek.com;
   - `GOOGLE_GENERATIVE_AI_API_KEY` — aistudio.google.com (бесплатно, без карты).
3. **Демо-база**: `npm run seed` (7 документов интернет-магазина «Северный»).
4. **Запуск**: `npm run dev` → http://localhost:3000
5. Спросите: «Сколько идёт возврат денег?» — ответ придёт с цитатами.

## Деплой на Vercel

1. Пуш на GitHub → Import в Vercel (или `npx vercel`).
2. Project → Settings → Environment Variables — те же 4 переменные, что в `.env.local`.
3. Deploy. Сборка не требует env (всё читается лениво в рантайме).

## Архитектура

- `sql/0001_init.sql` — bots, documents, chunks (vector(1536) + tsvector), conversations,
  messages, feedback, quota_counters; функции `match_chunks` / `search_chunks_fts`;
  RLS включён без анонимных политик.
- `lib/env.ts` — серверные переменные, ленивое чтение (сборка без env).
- `lib/supabase.ts` — серверный клиент (service role). Браузер в Supabase не ходит.
- `lib/embeddings.ts` — сменный слой эмбеддингов (Gemini, 1536 dims, батчи по 32).
- `lib/models.ts` — реестр LLM (`provider:model`): DeepSeek flash / v4-pro.
- `lib/retrieval.ts` — гибридный поиск: pgvector + FTS → слияние RRF (k=60).
- `lib/prompts.ts` — системный промпт + контекст с маркерами `[n]`.
- `lib/chat-store.ts` — персистенция диалогов, токенов и стоимости.
- `app/api/chat/route.ts` — валидация бота → ретрив → `streamText` → UI-стрим
  (источники уходят клиенту data-частью `data-sources`).
- `app/page.tsx` + `app/chat.tsx` — чат-страница (`useChat`, цитаты-чипы, статусы).
- `scripts/seed.ts` — идемпотентный сид демо-базы (hash-проверка, пропуск неизменённых).

## Заметки

- Thinking-режим DeepSeek V4 выключен по умолчанию (`bots.thinking_enabled=false`) — ниже
  латентность; включение — поправка флага у бота (температура при thinking игнорируется).
- Смена эмбеддинг-провайдера: правка `lib/embeddings.ts` + `vector(N)` в SQL + повторный seed
  (смена модели эмбеддингов = полная переиндексация).
- Роадмап: Фаза 2 — админка и ingestion со статусами; Фаза 3 — виджет `<script>` +
  origin-allowlist + квоты; Фаза 4 — evals/CI, опционально Langfuse.
