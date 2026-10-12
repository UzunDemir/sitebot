/**
 * Admin stats API: a compact summary for one bot over the last N days.
 * Demo-scale aggregation in JS (bounded by recent data volume).
 */

import { connection } from 'next/server';
import { adminGuard } from '@/lib/admin-auth';
import { getSupabase } from '@/lib/supabase';

/** Next.js uses NEXT_* digest errors to control prerendering — never swallow them. */
function isNextInternalError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'digest' in err &&
      String((err as { digest?: unknown }).digest ?? '').startsWith('NEXT_'),
  );
}

type MessageRow = {
  id: number;
  role: string;
  latency_ms: number | null;
  cost_usd: number | string | null;
  input_tokens: number | null;
  output_tokens: number | null;
};

export async function GET(req: Request): Promise<Response> {
  await connection();

  const guard = adminGuard(req);
  if (guard) return guard;

  try {
    const url = new URL(req.url);
    const botId = url.searchParams.get('botId')?.trim() ?? '';
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? '7') || 7));
    if (!botId) {
      return Response.json({ error: 'no_bot' }, { status: 400 });
    }

    const supabase = getSupabase();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const conversations = await supabase
      .from('conversations')
      .select('id')
      .eq('bot_id', botId)
      .gte('created_at', since);
    if (conversations.error) throw conversations.error;
    const conversationIds = (conversations.data ?? []).map((row) => row.id as string);

    let messages: MessageRow[] = [];
    if (conversationIds.length > 0) {
      const res = await supabase
        .from('messages')
        .select('id, role, latency_ms, cost_usd, input_tokens, output_tokens')
        .in('conversation_id', conversationIds.slice(0, 500));
      if (res.error) throw res.error;
      messages = (res.data ?? []) as MessageRow[];
    }

    const assistant = messages.filter((m) => m.role === 'assistant');
    const assistantIds = assistant.map((m) => m.id);

    let up = 0;
    let down = 0;
    if (assistantIds.length > 0) {
      const fb = await supabase
        .from('feedback')
        .select('rating')
        .in('message_id', assistantIds.slice(0, 500));
      if (fb.error) throw fb.error;
      for (const row of fb.data ?? []) {
        if (row.rating === 1) up += 1;
        if (row.rating === -1) down += 1;
      }
    }

    const sum = (pick: (m: MessageRow) => number | string | null): number =>
      messages.reduce((acc, m) => {
        const value = Number(pick(m) ?? 0);
        return acc + (Number.isFinite(value) ? value : 0);
      }, 0);

    const latencies = assistant
      .map((m) => m.latency_ms)
      .filter((value): value is number => typeof value === 'number');
    const avgLatencyMs =
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0;

    return Response.json({
      stats: {
        days,
        conversations: conversationIds.length,
        messages: messages.length,
        answers: assistant.length,
        up,
        down,
        avgLatencyMs,
        inputTokens: sum((m) => m.input_tokens),
        outputTokens: sum((m) => m.output_tokens),
        totalCostUsd: Number(sum((m) => m.cost_usd).toFixed(4)),
      },
    });
  } catch (err) {
    if (isNextInternalError(err)) throw err;
    console.error('[admin] stats failed:', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
