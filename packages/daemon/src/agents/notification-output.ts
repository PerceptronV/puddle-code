import { open } from 'node:fs/promises';

/** Read only a bounded suffix of an exact conversation, never an account-wide history. */
export async function lastJsonlOutput(
  path: string,
  pick: (record: Record<string, unknown>) => string | null | undefined,
): Promise<string | null> {
  const file = await open(path, 'r').catch(() => null);
  if (!file) return null;
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - 128 * 1024);
    const buffer = Buffer.alloc(Math.min(size, 128 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start) lines.shift();
    for (const line of lines.reverse()) {
      try {
        const record: unknown = JSON.parse(line);
        if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
        const result = pick(record as Record<string, unknown>);
        // null is a newer user turn: do not resurrect an older reply.
        if (result !== undefined) return result;
      } catch {
        /* A partial trailing record is normal while the agent flushes. */
      }
    }
    return null;
  } finally {
    await file.close();
  }
}
