import { constants, lstatSync, renameSync, type Stats } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { LogRetentionOptions } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const COPY_BYTES = 64 * 1024;
export interface LogCandidate {
  stream: string;
  term: string;
  file: string;
  directory: string;
  root: Stats;
  parent: Stats;
}

function unchanged(before: Stats, after: Stats): boolean {
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}
export function sameDirectory(path: string, before: Stats): boolean {
  const after = lstatSync(path);
  return (
    after.isDirectory() &&
    !after.isSymbolicLink() &&
    before.dev === after.dev &&
    before.ino === after.ino
  );
}

/** The existing exact-tail copy and final synchronous replacement boundary. */
export async function compactLog(
  candidate: LogCandidate,
  options: LogRetentionOptions,
  stopped: () => boolean,
): Promise<{ status: 'compacted'; bytes: number } | { status: 'skipped' | 'failed' | 'stopped' }> {
  const { stream, term, file, directory, root, parent } = candidate;
  let temporary: string | null = null;
  try {
    if (stopped()) return { status: 'stopped' };
    if (
      !sameDirectory(options.logsDir, root) ||
      !sameDirectory(directory, parent) ||
      options.isBusy(stream, term)
    )
      return { status: 'skipped' };
    const before = await lstat(file);
    if (stopped()) return { status: 'stopped' };
    const cutoff = (options.now ?? Date.now()) - options.retentionDays * DAY_MS;
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.mtimeMs >= cutoff ||
      before.size <= options.replayBytes
    )
      return { status: 'skipped' };
    const source = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (stopped()) return { status: 'stopped' };
      if (!unchanged(before, await source.stat())) return { status: 'skipped' };
      if (stopped()) return { status: 'stopped' };
      temporary = `${file}.retention-${randomUUID()}`;
      const target = await open(temporary, 'wx', before.mode & 0o777);
      try {
        if (stopped()) return { status: 'stopped' };
        const buffer = Buffer.alloc(Math.min(COPY_BYTES, options.replayBytes));
        let remaining = options.replayBytes;
        let position = before.size - remaining;
        while (remaining > 0) {
          if (stopped()) return { status: 'stopped' };
          if (options.isBusy(stream, term)) return { status: 'skipped' };
          const { bytesRead } = await source.read(
            buffer,
            0,
            Math.min(buffer.length, remaining),
            position,
          );
          if (stopped()) return { status: 'stopped' };
          if (!bytesRead) return { status: 'skipped' };
          let written = 0;
          while (written < bytesRead) {
            if (stopped()) return { status: 'stopped' };
            const { bytesWritten } = await target.write(buffer, written, bytesRead - written);
            if (stopped()) return { status: 'stopped' };
            if (!bytesWritten) throw new Error('Terminal log compaction made no progress');
            written += bytesWritten;
          }
          remaining -= bytesRead;
          position += bytesRead;
        }
        await target.utimes(before.atime, before.mtime);
        if (stopped()) return { status: 'stopped' };
        await target.sync();
        if (stopped()) return { status: 'stopped' };
      } finally {
        await target.close();
      }
      // A stale traversal or a newly admitted writer cannot publish the copy.
      if (stopped()) return { status: 'stopped' };
      if (
        options.isBusy(stream, term) ||
        !sameDirectory(options.logsDir, root) ||
        !sameDirectory(directory, parent) ||
        !unchanged(before, lstatSync(file))
      )
        return { status: 'skipped' };
      renameSync(temporary, file);
      temporary = null;
      return { status: 'compacted', bytes: before.size - options.replayBytes };
    } finally {
      await source.close();
    }
  } catch {
    return { status: 'failed' };
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
  }
}
