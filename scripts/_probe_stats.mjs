import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const s = line.trim();
  if (!s || s.startsWith('#')) continue;
  const i = s.indexOf('=');
  if (i === -1) continue;
  env[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY);
const bots = await supabase.from('bots').select('id, name').eq('is_active', true).limit(1);
const botId = bots.data?.[0]?.id;
const base = 'https://sitebot-nu.vercel.app';
const login = await fetch(`${base}/api/admin/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: env.ADMIN_SECRET }),
});
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const stats = await fetch(`${base}/api/admin/stats?botId=${botId}&days=7`, { headers: { cookie } });
const json = await stats.json().catch(() => null);
console.log('login:', login.status, '| stats:', stats.status);
console.log('keys:', Object.keys(json?.stats ?? {}).join(','));
console.log('refusals:', json?.stats?.refusals, '| tactics:', JSON.stringify(json?.stats?.tactics ?? null));
console.log('styleFlags:', JSON.stringify(json?.stats?.styleFlags ?? null));
