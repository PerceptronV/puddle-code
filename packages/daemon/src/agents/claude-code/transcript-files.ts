import { open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

/** Native project buckets can be symlinked into a profile's shared store. */
export async function* transcriptFiles(configDir: string): AsyncGenerator<string> {
  const root = join(configDir, 'projects');
  const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory() && !project.isSymbolicLink()) continue;
    const directory = join(root, project.name);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries)
      if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.jsonl'))
        yield join(directory, entry.name);
  }
}

export async function transcriptHead(handle: FileHandle): Promise<string> {
  const buffer = Buffer.allocUnsafe(16_384);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  return buffer.toString('utf8', 0, bytesRead);
}

/** Recovery preserves newest-matching-cwd selection without reading transcript bodies. */
export async function discoverClaudeRef(
  configDir: string,
  worktreePath: string,
): Promise<string | null> {
  const targets = new Set([worktreePath]);
  const canonical = await realpath(worktreePath).catch(() => null);
  if (canonical) targets.add(canonical);
  let best: { ref: string; mtime: number } | null = null;
  for await (const path of transcriptFiles(configDir)) {
    const file = await open(path, 'r').catch(() => null);
    if (!file) continue;
    try {
      const head = await transcriptHead(file);
      const matches = head
        .split('\n')
        .slice(0, 10)
        .some((line) => {
          try {
            const value: unknown = JSON.parse(line);
            return (
              !!value &&
              typeof value === 'object' &&
              'cwd' in value &&
              typeof value.cwd === 'string' &&
              targets.has(value.cwd)
            );
          } catch {
            return false;
          }
        });
      if (!matches) continue;
      const { mtimeMs } = await file.stat();
      if (!best || mtimeMs > best.mtime)
        best = { ref: path.split('/').pop()!.slice(0, -'.jsonl'.length), mtime: mtimeMs };
    } catch {
      // Native writers can remove or replace a file while discovery is running.
    } finally {
      await file.close();
    }
  }
  return best?.ref ?? null;
}
