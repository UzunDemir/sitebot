/**
 * Structural text chunker: splits on blank lines (paragraphs/headings),
 * packs paragraphs up to maxChars, adds a small character overlap.
 * No external dependencies; good enough until Phase 2 ingestion refines it.
 */

export type ChunkDraft = { idx: number; content: string };

export type ChunkOptions = {
  /** Soft cap for chunk size in characters. */
  maxChars?: number;
  /** Overlap between adjacent chunks in characters. */
  overlapChars?: number;
};

export function chunkDocument(text: string, opts: ChunkOptions = {}): ChunkDraft[] {
  const maxChars = opts.maxChars ?? 1200;
  const overlap = opts.overlapChars ?? 150;

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > maxChars) {
      chunks.push(current);
      const tail = current.slice(-overlap);
      current = tail + '\n\n' + paragraph;
    } else {
      current = current ? current + '\n\n' + paragraph : paragraph;
    }

    // Hard split for a single oversized paragraph.
    while (current.length > maxChars * 2) {
      chunks.push(current.slice(0, maxChars));
      current = current.slice(maxChars - overlap);
    }
  }

  if (current.trim()) {
    chunks.push(current);
  }

  return chunks.map((content, idx) => ({ idx, content }));
}
