/**
 * Admin documents API: list per bot and upload (txt / md / pdf).
 * Uploads run through the shared ingestion pipeline (chunk -> embed -> store).
 */

import { adminGuard } from '@/lib/admin-auth';
import { getSupabase } from '@/lib/supabase';
import { ingestDocument } from '@/lib/ingest';

export const maxDuration = 60;

const MAX_FILE_BYTES = 4_000_000;

export async function GET(req: Request): Promise<Response> {
  const guard = adminGuard(req);
  if (guard) return guard;

  const botId = new URL(req.url).searchParams.get('botId') ?? '';
  if (!botId) {
    return Response.json({ error: 'no_bot' }, { status: 400 });
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('documents')
    .select('id, title, source, status, error, chunk_count, created_at, updated_at')
    .eq('bot_id', botId)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[admin] documents list failed:', error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }

  return Response.json({ documents: data ?? [] });
}

export async function POST(req: Request): Promise<Response> {
  const guard = adminGuard(req);
  if (guard) return guard;

  const contentType = req.headers.get('content-type') ?? '';

  let botId = '';
  let title = '';
  let source: string | null = null;
  let content = '';

  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    botId = String(form.get('botId') ?? '').trim();
    title = String(form.get('title') ?? '').trim();

    const file = form.get('file');
    if (!(file instanceof File)) {
      return Response.json({ error: 'no_file' }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > MAX_FILE_BYTES) {
      return Response.json(
        { error: 'file_too_large', message: 'Файл больше 4 МБ — разделите его на части.' },
        { status: 400 },
      );
    }

    const name = file.name || 'document.txt';
    const lower = name.toLowerCase();
    source = name;

    if (lower.endsWith('.pdf') || file.type === 'application/pdf') {
      try {
        const { extractText, getDocumentProxy } = await import('unpdf');
        const pdf = await getDocumentProxy(new Uint8Array(buf));
        const extracted = await extractText(pdf, { mergePages: true });
        content = Array.isArray(extracted.text) ? extracted.text.join('\n\n') : extracted.text ?? '';
      } catch (err) {
        console.error('[admin] pdf parse failed:', err);
        return Response.json(
          { error: 'pdf_parse_failed', message: 'Не удалось извлечь текст из PDF. Попробуйте другой файл.' },
          { status: 400 },
        );
      }
    } else if (
      lower.endsWith('.txt') ||
      lower.endsWith('.md') ||
      lower.endsWith('.markdown') ||
      file.type.startsWith('text/')
    ) {
      content = buf.toString('utf8');
    } else {
      return Response.json(
        { error: 'unsupported_type', message: 'Поддерживаются файлы .txt, .md и .pdf.' },
        { status: 400 },
      );
    }

    if (!title) title = name.replace(/\.[^.]+$/, '');
  } else {
    const body = (await req.json().catch(() => null)) as {
      botId?: string;
      title?: string;
      content?: string;
      source?: string;
    } | null;
    botId = body?.botId?.trim() ?? '';
    title = body?.title?.trim() ?? '';
    content = typeof body?.content === 'string' ? body.content : '';
    source = body?.source?.trim() || null;
  }

  if (!botId) {
    return Response.json({ error: 'no_bot' }, { status: 400 });
  }

  const supabase = getSupabase();
  const bot = await supabase.from('bots').select('id').eq('id', botId).maybeSingle();
  if (bot.error) {
    console.error('[admin] bot lookup failed:', bot.error);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
  if (!bot.data) {
    return Response.json({ error: 'bot_not_found' }, { status: 404 });
  }

  try {
    const outcome = await ingestDocument({ botId, title, source, content });
    return Response.json({ ok: true, ...outcome });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[admin] ingest failed:', message);
    return Response.json({ error: 'ingest_failed', message }, { status: 422 });
  }
}
