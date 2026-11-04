import type { Dir, Dirent, Stats } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { compactLog, sameDirectory, type LogCandidate } from './copy.js';
import {
  emptyRetentionResult,
  LOG_RETENTION_LIMITS,
  type LogRetentionOptions,
  type LogRetentionResult,
} from './types.js';

interface DirectoryCursor {
  path: string;
  stat: Stats;
  handle: Dir;
  entry?: Dirent | null;
}
interface StreamCursor extends DirectoryCursor {
  name: string;
}
const STOPPED_COPY_ATTEMPTS = 3;

/** Two bounded directory handles replace whole-directory arrays; slices resume fairly. */
export class TerminalLogCompactor {
  private root: DirectoryCursor | null = null;
  private stream: StreamCursor | null = null;
  private candidate: LogCandidate | null = null;
  private stoppedCopies = 0;
  private configuration = '';
  private closed = false;
  private active: Promise<LogRetentionResult> | null = null;

  sweep(options: LogRetentionOptions): Promise<LogRetentionResult> {
    if (this.closed) return Promise.resolve(emptyRetentionResult());
    if (this.active) return this.active;
    this.active = this.slice(options)
      .catch(async (error) => {
        await this.reset();
        throw error;
      })
      .finally(() => {
        this.active = null;
      });
    return this.active;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.active?.catch(() => {});
    await this.reset();
  }

  private async reset(): Promise<void> {
    const stream = this.stream;
    const root = this.root;
    this.stream = null;
    this.root = null;
    this.candidate = null;
    this.stoppedCopies = 0;
    await stream?.handle.close().catch(() => {});
    await root?.handle.close().catch(() => {});
  }

  private async slice(options: LogRetentionOptions): Promise<LogRetentionResult> {
    if (
      !Number.isSafeInteger(options.retentionDays) ||
      options.retentionDays < 0 ||
      !Number.isSafeInteger(options.replayBytes) ||
      options.replayBytes < 1024 ||
      (options.deadline !== undefined && !Number.isFinite(options.deadline))
    )
      throw new Error('Invalid terminal log retention settings');
    const limits = { ...LOG_RETENTION_LIMITS };
    for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
      const value = options.limits?.[key] ?? limits[key];
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error('Invalid log retention budget');
      limits[key] = Math.min(limits[key], value);
    }
    const result = emptyRetentionResult(false);
    const deadline = Math.min(
      performance.now() + limits.milliseconds,
      options.deadline ?? Infinity,
    );
    const stopped = () =>
      this.closed || options.stopped?.() === true || performance.now() >= deadline;
    const configuration = JSON.stringify([
      options.logsDir,
      options.retentionDays,
      options.replayBytes,
    ]);
    if (configuration !== this.configuration || options.retentionDays === 0) {
      await this.reset();
      this.configuration = configuration;
    }
    if (options.retentionDays === 0) return emptyRetentionResult();
    if (stopped()) return result;
    if (this.root) {
      try {
        if (
          !sameDirectory(this.root.path, this.root.stat) ||
          (this.stream && !sameDirectory(this.stream.path, this.stream.stat))
        ) {
          await this.reset();
          return result;
        }
      } catch {
        await this.reset();
        return result;
      }
    } else {
      let stat: Stats;
      try {
        stat = await lstat(options.logsDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRetentionResult();
        throw error;
      }
      if (stopped()) return result;
      if (!stat.isDirectory() || stat.isSymbolicLink()) return emptyRetentionResult();
      const handle = await opendir(options.logsDir, { bufferSize: 1 });
      this.root = { path: options.logsDir, stat, handle };
    }
    let entries = 0;
    let files = 0;
    let copyBytes = 0;
    while (!stopped()) {
      if (this.candidate) {
        if (files >= limits.files) break;
        if (options.replayBytes > limits.copyBytes) {
          // Large configured replay windows are never shortened to fit upkeep.
          this.candidate = null;
          this.stoppedCopies = 0;
          files++;
          result.skipped++;
          continue;
        }
        if (copyBytes + options.replayBytes > limits.copyBytes) break;
        files++;
        copyBytes += options.replayBytes;
        const copied = await compactLog(this.candidate, options, stopped);
        if (copied.status === 'stopped') {
          // A consistently slow copy/fsync must not starve later files/owners.
          // Skip intact after bounded retries; the next full scan can revisit it.
          if (++this.stoppedCopies >= STOPPED_COPY_ATTEMPTS) {
            this.candidate = null;
            this.stoppedCopies = 0;
            result.skipped++;
          }
          break;
        }
        this.candidate = null;
        this.stoppedCopies = 0;
        if (copied.status === 'compacted') {
          result.compacted++;
          result.reclaimedBytes += copied.bytes;
        } else result[copied.status]++;
        continue;
      }
      if (entries >= limits.entries) break;
      const cursor = this.stream ?? this.root;
      if (!cursor) {
        result.complete = true;
        break;
      }
      if (cursor.entry === undefined) {
        cursor.entry = await cursor.handle.read();
        entries++;
      }
      if (stopped()) break;
      const entry = cursor.entry;
      if (entry === null) {
        await cursor.handle.close();
        if (this.stream) this.stream = null;
        else {
          this.root = null;
          result.complete = true;
          break;
        }
        continue;
      }
      if (this.stream) {
        cursor.entry = undefined;
        if (!entry.name.endsWith('.log')) continue;
        this.candidate = {
          stream: this.stream.name,
          term: entry.name.slice(0, -4),
          file: join(this.stream.path, entry.name),
          directory: this.stream.path,
          root: this.root!.stat,
          parent: this.stream.stat,
        };
        this.stoppedCopies = 0;
      } else {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          cursor.entry = undefined;
          continue;
        }
        const path = join(cursor.path, entry.name);
        try {
          const stat = await lstat(path);
          if (stopped()) break;
          if (!stat.isDirectory() || stat.isSymbolicLink()) {
            cursor.entry = undefined;
            continue;
          }
          const handle = await opendir(path, { bufferSize: 1 });
          this.stream = { path, name: entry.name, stat, handle };
          cursor.entry = undefined;
        } catch {
          cursor.entry = undefined;
          result.failed++;
        }
      }
    }
    return result;
  }
}
