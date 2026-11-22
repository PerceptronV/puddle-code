import { open } from 'node:fs/promises';

const HEADER_BYTES = 64 * 1024;
const cache = new Map<string, { size: number; mtimeMs: number; ref: string; empty: boolean }>();

/** Bounded startup-record inspection; unknown/large native formats are retained. */
export async function geminiHistory(
  path: string,
  fallbackRef: string,
  stats: { size: number; mtimeMs: number },
): Promise<{ ref: string; empty: boolean }> {
  const cached = cache.get(path);
  if (cached?.size === stats.size && cached.mtimeMs === stats.mtimeMs) return cached;
  const file = await open(path, 'r');
  let text: string;
  let complete: boolean;
  try {
    const buffer = Buffer.alloc(Math.min(stats.size, HEADER_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    text = buffer.toString('utf8', 0, bytesRead);
    complete = bytesRead === stats.size;
  } finally {
    await file.close();
  }
  let ref = fallbackRef;
  // Legacy JSON can exceed the inspection window after its first prompt.
  // Its leading metadata still supplies the full UUID rather than the short filename id.
  const leadingRef = /^\s*\{\s*"sessionId"\s*:\s*("(?:\\.|[^"\\])*")/.exec(text);
  if (leadingRef) ref = JSON.parse(leadingRef[1]!) as string;
  let empty = complete;
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      empty = false;
      return;
    }
    const row = value as Record<string, unknown>;
    if (typeof row.sessionId === 'string' && row.sessionId) ref = row.sessionId;
    if (Array.isArray(row.messages)) {
      for (const message of row.messages) inspect(message);
    } else if (row.type === 'info' || row.type === 'warning' || row.type === 'error') {
      // Gemini excludes these startup/status records from resumable content.
    } else if (row.type === 'user' || row.type === 'gemini') {
      // Preserve any potential content, including multimodal parts and tool calls.
      if (
        (typeof row.content === 'string' && row.content.trim()) ||
        (Array.isArray(row.content) && row.content.length) ||
        (Array.isArray(row.toolCalls) && row.toolCalls.length) ||
        (Array.isArray(row.thoughts) && row.thoughts.length)
      )
        empty = false;
    } else if (!('sessionId' in row) || 'type' in row) {
      empty = false;
    }
  };
  try {
    inspect(JSON.parse(text));
  } catch {
    // Current Gemini writes JSONL, with session metadata before message records.
    for (const line of text.split('\n').filter((line) => line.trim())) {
      try {
        inspect(JSON.parse(line));
      } catch {
        empty = false;
      }
    }
  }
  const result = { ...stats, ref, empty };
  cache.delete(path);
  cache.set(path, result);
  if (cache.size > 4096) cache.delete(cache.keys().next().value!);
  return result;
}
