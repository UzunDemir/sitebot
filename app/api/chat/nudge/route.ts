/**
 * Proactive nudge endpoint (Ф3).
 *
 * POST { botKey, sessionKey, visitorKey?, tz? }
 *
 * The widget asks the server for permission to touch a silent visitor and
 * gets the message text. The server is the single source of truth:
 * proactive.enabled, DND, quiet hours (visitor timezone), attempt limit,
 * timing since the last message/nudge and the conversation state.
 *
 * Denials carry a machine-readable reason: disabled | no_dialog | closed |
 * dnd | quiet_hours (+nextAllowedAt) | limit | too_early (+retryAfterMs).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '@/lib/supabase';
import {
  effectiveAggressiveness,
  effectiveProactive,
  isMissingColumnError,
  parseBotSettings,
} from '@/lib/bot-settings';
import {
  loadConversationByKey,
  loadRecentMessages,
  saveAssistantMessage,
  updateConversationFields,
} from '@/lib/chat-store';
import { loadVisitorByKey, recordEvent } from '@/lib/visitors';
import {
  generateNudgeText,
  inQuietWindow,
  localMinutes,
  minutesOf,
  quietHoursEnd,
} from '@/lib/nudge';

export const maxDuration = 60;

type NudgeBody = {
  botKey?: string;
  sessionKey?: string;
  visitorKey?: string;
  tz?: string;
};

type NudgeBot = { id: string; name: string; settings?: unknown };

/** Bot + settings; gracefully degrades when sql/0002 is not applied. */
async function fetchBot(supabase: SupabaseClient, publicKey: string): Promise<NudgeBot | null> {
  const build = (columns: string) =>
    supabase.from('bots').select(columns).eq('public_key', publicKey).eq('is_active', true).maybeSingle();

  let result = await build('id, name, settings');
  if (result.error && isMissingColumnError(result.error)) {
    result = await build('id, name');
  }
  if (result.error) throw result.error;
  return (result.data as NudgeBot | null) ?? null;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => null)) as NudgeBody | null;
    const botKey = body?.botKey?.trim() ?? '';
    const sessionKey = body?.sessionKey?.trim() ?? '';
    const visitorKey = body?.visitorKey?.trim() ?? '';
    if (!botKey || !sessionKey) {
      return Response.json({ error: 'bad_request' }, { status: 400 });
    }

    const supabase = getSupabase();
    const bot = await fetchBot(supabase, botKey);
    if (!bot) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }

    const settings = parseBotSettings(bot.settings);
    const proactive = effectiveProactive(settings);
    const deny = (reason: string, extra: Record<string, unknown> = {}) =>
      Response.json({ allowed: false, reason, ...extra });

    if (!proactive.enabled || proactive.attempts <= 0) return deny('disabled');

    const conversation = await loadConversationByKey(bot.id, sessionKey);
    if (!conversation) return deny('no_dialog');
    // Глухие стопы: цель достигнута или посетитель просил не писать.
    if (
      conversation.outcome === 'goal_reached' ||
      conversation.outcome === 'stopped' ||
      conversation.stage === 'done'
    ) {
      return deny('closed');
    }
    // Потерянный диалог не глухо закрыт: реактивационное касание и вся серия
    // (по лимиту «касаний подряд») продолжаются, пока клиент не ответил.
    const reactivation = conversation.outcome === 'lost' || conversation.stage === 'lost';

    const visitor = visitorKey ? await loadVisitorByKey(bot.id, visitorKey) : null;
    if (visitor?.do_not_disturb) return deny('dnd');

    const now = new Date();

    // --- quiet hours in the visitor's timezone (client sends its tz)
    if (proactive.quietHours.enabled) {
      const tz = body?.tz?.trim() ?? '';
      const fromMinutes = minutesOf(proactive.quietHours.from);
      const toMinutes = minutesOf(proactive.quietHours.to);
      const nowMinutes = tz ? localMinutes(tz, now) : null;
      if (
        fromMinutes !== null &&
        toMinutes !== null &&
        nowMinutes !== null &&
        inQuietWindow(nowMinutes, fromMinutes, toMinutes)
      ) {
        const end = quietHoursEnd(now, tz, toMinutes);
        return deny('quiet_hours', end ? { nextAllowedAt: end.toISOString() } : {});
      }
    }

    if (conversation.nudgesSent >= proactive.attempts) return deny('limit');

    // --- timing: silence since the last message or nudge (0.9 tolerance)
    const { messages } = await loadRecentMessages(conversation.id, 12);
    const lastMessageAt = messages.length > 0 ? new Date(messages[messages.length - 1].createdAt) : null;
    const lastNudgeAt = conversation.lastNudgeAt ? new Date(conversation.lastNudgeAt) : null;
    const lastActivity = [lastMessageAt, lastNudgeAt]
      .filter((value): value is Date => value !== null && !Number.isNaN(value.getTime()))
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const elapsedSec = lastActivity ? (now.getTime() - lastActivity.getTime()) / 1000 : Infinity;
    const requiredSec =
      conversation.nudgesSent === 0
        ? proactive.firstDelaySec
        : proactive.intervalSec * Math.pow(2, conversation.nudgesSent - 1);
    if (elapsedSec < requiredSec * 0.9) {
      return deny('too_early', {
        retryAfterMs: Math.max(5000, Math.ceil((requiredSec - elapsedSec) * 1000)),
      });
    }

    // --- generate the touch text (cheap model, canned fallback)
    const attempt = conversation.nudgesSent + 1;
    const transcript = messages
      .map((message) => `${message.role === 'user' ? 'Посетитель' : 'Ассистент'}: ${message.content}`)
      .join('\n')
      .slice(-6000);

    const text = await generateNudgeText({
      // Реактивация потерянной беседы звучит как «последнее предложение».
      attempt: reactivation && attempt === 1 ? 3 : attempt,
      stage: conversation.stage,
      settings,
      visitor: {
        name: visitor?.name ?? null,
        contacts: visitor?.contacts ?? {},
        digest: visitor?.memory_digest ?? '',
      },
      dialog: transcript,
    });

    // --- persist as a proactive message and bump the counters
    const startedAt = Date.now();
    let messageId: number | null = null;
    try {
      messageId = await saveAssistantMessage(conversation.id, {
        content: text,
        citations: [],
        model: 'deepseek:deepseek-flash',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: Date.now() - startedAt,
        isProactive: true,
        nudgeNumber: attempt,
      });
    } catch (err) {
      console.warn('[nudge] failed to persist nudge:', err);
    }

    await updateConversationFields(conversation.id, {
      nudges_sent: attempt,
      last_nudge_at: now.toISOString(),
      last_active_at: now.toISOString(),
      stage: 'followup',
    });
    await recordEvent({
      botId: bot.id,
      visitorId: visitor?.id ?? conversation.visitorId,
      conversationId: conversation.id,
      type: 'nudge_sent',
      payload: { nudge: attempt, aggressiveness: effectiveAggressiveness(settings), reactivation },
    });

    return Response.json({ allowed: true, text, nudgeNumber: attempt, messageId });
  } catch (err) {
    console.error('[nudge] unhandled error:', err);
    return Response.json({ allowed: false, reason: 'error' }, { status: 500 });
  }
}
