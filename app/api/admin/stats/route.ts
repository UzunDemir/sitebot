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

    // --- шкалы/тактики (стиль 2.0, стратег 2.0): агрегаты по событиям.
    // Работает сразу, до sql/0007: события пишутся и в режиме деградации.
    let refusals = 0;
    let tactics: Array<{ tactic: string; sent: number; goalReached: number; conversion: number }> = [];
    let styleFlags: Array<{ flag: string; count: number }> = [];
    if (conversationIds.length > 0) {
      const evRes = await supabase
        .from('events')
        .select('type, payload, conversation_id')
        .eq('bot_id', botId)
        .in('type', ['tactic_used', 'refusal', 'style_flags', 'goal_reached'])
        .gte('created_at', since);
      if (evRes.error) throw evRes.error;
      const rows = (evRes.data ?? []) as Array<{
        type: string;
        payload: Record<string, unknown> | null;
        conversation_id: string | null;
      }>;

      const goals = new Set(
        rows.filter((row) => row.type === 'goal_reached' && row.conversation_id).map((row) => row.conversation_id as string),
      );
      const perTactic = new Map<string, { sent: number; conversations: Set<string> }>();
      const perFlag = new Map<string, number>();

      for (const row of rows) {
        if (row.type === 'refusal') refusals += 1;
        if (row.type === 'tactic_used') {
          const id = typeof row.payload?.tactic === 'string' ? row.payload.tactic : 'unknown';
          const entry = perTactic.get(id) ?? { sent: 0, conversations: new Set<string>() };
          entry.sent += 1;
          if (row.conversation_id) entry.conversations.add(row.conversation_id);
          perTactic.set(id, entry);
        }
        if (row.type === 'style_flags') {
          const flags = Array.isArray(row.payload?.flags) ? (row.payload.flags as unknown[]) : [];
          for (const flag of flags) {
            if (typeof flag === 'string') perFlag.set(flag, (perFlag.get(flag) ?? 0) + 1);
          }
        }
      }

      tactics = Array.from(perTactic.entries())
        .map(([tactic, entry]) => {
          const reached = Array.from(entry.conversations).filter((id) => goals.has(id)).length;
          return {
            tactic,
            sent: entry.sent,
            goalReached: reached,
            conversion:
              entry.conversations.size > 0 ? Math.round((reached / entry.conversations.size) * 100) : 0,
          };
        })
        .sort((a, b) => b.sent - a.sent)
        .slice(0, 8);

      styleFlags = Array.from(perFlag.entries())
        .map(([flag, count]) => ({ flag, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);
    }

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
        refusals,
        tactics,
        styleFlags,
      },
    });
  } catch (err) {
    if (isNextInternalError(err)) throw err;
    console.error('[admin] stats failed:', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}
