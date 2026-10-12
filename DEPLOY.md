# Деплой на Vercel

Всё для публикации бота. Ключи не нужны на этапе сборки — приложение читает
переменные окружения в рантайме, поэтому деплой и в Vercel, и локально работает
с одним и тем же `.env.local`.

## Вариант A — через GitHub (рекомендуется)

Дальше это даст авто-деплой: каждый push в `master` обновляет прод автоматически.

1. GitHub → **New repository** → имя `sitebot`, репозиторий **пустой**
   (без README и .gitignore).
2. В терминале:
   ```bash
   cd C:\sitebot
   git remote add origin https://github.com/<ВАШ-ЛОГИН>/sitebot.git
   git push -u origin master
   ```
   Если Git Credential Manager попросит вход — откроется окно браузера, подтвердите.
3. vercel.com → **Add New… → Project → Import Git Repository** → `sitebot`.
4. Framework Preset определится сам (Next.js) — ничего не менять.
5. Раскройте **Environment Variables** и добавьте четыре (для Production;
   значения копируйте из `.env.local`):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (он же новый `SUPABASE_SECRET_KEY`)
   - `DEEPSEEK_API_KEY`
   - `GOOGLE_GENERATIVE_AI_API_KEY`
6. **Deploy** (~1–2 минуты). Проверка: открыть выданный URL и задать
   «Сколько идёт возврат денег?» — ответ придёт с источниками.

## Вариант B — через Vercel CLI (без GitHub)

```bash
cd C:\sitebot
npx vercel login
npx vercel link
npx vercel env add SUPABASE_URL production
npx vercel env add SUPABASE_SERVICE_ROLE_KEY production
npx vercel env add DEEPSEEK_API_KEY production
npx vercel env add GOOGLE_GENERATIVE_AI_API_KEY production
npx vercel deploy --prod
```

## Если что-то не работает

- «База знаний ещё не подключена» → в Vercel нет или неверны env-переменные;
  после добавления обязательно **Redeploy**.
- `Invalid API key` → вставлен publishable-ключ вместо service_role/secret.
- Пустой или ошибочный ответ модели → проверьте `DEEPSEEK_API_KEY`;
  детали — Vercel → Deployment → Logs (там же видны ошибки эмбеддингов).
- Локально работает, прод — нет → почти всегда дело в env-переменных
  именно прод-окружения.
- Посторонние видят 404 или просьбу войти в Vercel → включена Deployment
  Protection: Settings → Deployment Protection → Vercel Authentication →
  «Standard Protection» (прод публичный, превью защищены) или «Disabled».
  Применяется сразу, Redeploy не нужен.

## Заметки

- `.env.local` не попадает ни в git, ни в загрузку Vercel (`.gitignore` + `.vercelignore`).
- Изменение env-переменных применяется только после Redeploy.
- Для виджета (фаза 3) рекомендую привязать свой домен: Settings → Domains.
- Проверка после деплоя: `npm run smoke:e2e` бьёт по localhost; для прода
  пришлите URL — прогоню e2e против него.
