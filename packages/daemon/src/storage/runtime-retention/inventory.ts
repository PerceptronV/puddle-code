import type { Dir, Dirent, Stats } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { inventoryLimits, type RuntimeInventoryLimits } from './limits.js';
import { runtimeStorageCategory, type RuntimeStorageCategory } from './paths.js';

export type RuntimeInventoryIssue = 'unknown' | 'unsafe' | 'changed' | 'unavailable' | 'limit';
export interface RuntimeInventorySnapshot {
  state: 'scanning' | 'complete' | 'incomplete' | 'closed';
  startedAt: number;
  finishedAt: number | null;
  /** Logical bytes observed at individual stat times, not allocated blocks or an atomic snapshot. */
  bytes: Record<RuntimeStorageCategory, number>;
  files: number;
  directories: number;
  entries: number;
  nameBytes: number;
  issues: Record<RuntimeInventoryIssue, number>;
  pass: { entries: number; nameBytes: number };
}
interface Directory {
  relative: string;
  stat: Stats;
  ancestors: Directory[];
}
interface Cursor {
  directory: Directory;
  handle: Dir;
  pending?: Dirent;
}
const sameDirectory = (a: Stats, b: Stats) =>
  b.isDirectory() &&
  !b.isSymbolicLink() &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
const privateEntry = (stat: Stats) => stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;

/**
 * One explicitly requested owner's inventory. Retains one directory handle and a
 * bounded work queue across passes; completed results are cached until restart().
 * No polling, file-content reads or mutation. Callers must hold owner/launch
 * exclusion for stable accounting; this observation never proves owner exit or
 * grants reclamation/admission. Live file bytes may change without directory mtime.
 * The deadline is cooperative between bounded operations, not an OS I/O timeout.
 * Directory checks reject observed substitutions; they are not a portable openat
 * sandbox against concurrent same-user namespace replacement.
 */
export class RuntimeFilesystemInventory {
  private readonly limits: RuntimeInventoryLimits;
  private cursor: Cursor | null = null;
  private readonly queue: Directory[] = [];
  private active: Promise<RuntimeInventorySnapshot> | null = null;
  private initialised = false;
  private stopping = false;
  private state: RuntimeInventorySnapshot = this.empty();

  constructor(
    private readonly root: string,
    options: { limits?: Partial<RuntimeInventoryLimits>; clock?: () => number } = {},
  ) {
    if (!isAbsolute(root))
      throw new Error('Runtime inventory requires an absolute owner directory');
    this.limits = inventoryLimits(options.limits ?? {});
    this.clock = options.clock ?? (() => performance.now());
  }
  private readonly clock: () => number;
  private empty(): RuntimeInventorySnapshot {
    return {
      state: 'scanning',
      startedAt: Date.now(),
      finishedAt: null,
      bytes: {
        rawLogs: 0,
        checkpoints: 0,
        screens: 0,
        metadata: 0,
        protected: 0,
        temporary: 0,
        unknown: 0,
      },
      files: 0,
      directories: 0,
      entries: 0,
      nameBytes: 0,
      issues: { unknown: 0, unsafe: 0, changed: 0, unavailable: 0, limit: 0 },
      pass: { entries: 0, nameBytes: 0 },
    };
  }
  snapshot(): RuntimeInventorySnapshot {
    return structuredClone(this.state);
  }
  step(): Promise<RuntimeInventorySnapshot> {
    if (this.active) return this.active;
    if (this.state.state !== 'scanning' || this.stopping) {
      const cached = this.snapshot();
      cached.pass = { entries: 0, nameBytes: 0 };
      return Promise.resolve(cached);
    }
    this.active = this.advance().finally(() => {
      this.active = null;
    });
    return this.active;
  }
  async close(): Promise<void> {
    this.stopping = true;
    await this.active;
    await this.closeCursor();
    this.queue.length = 0;
    this.state.state = 'closed';
  }
  async restart(): Promise<void> {
    await this.close();
    this.state = this.empty();
    this.initialised = false;
    this.stopping = false;
  }
  private issue(reason: RuntimeInventoryIssue): void {
    this.state.issues[reason]++;
  }
  private async closeCursor(): Promise<void> {
    const cursor = this.cursor;
    this.cursor = null;
    await cursor?.handle.close().catch(() => {
      this.issue('unavailable');
    });
  }
  private async unchanged(directory: Directory): Promise<boolean> {
    for (const ancestor of [...directory.ancestors, directory]) {
      const observed = await lstat(join(this.root, ancestor.relative));
      if (!privateEntry(observed) || !sameDirectory(ancestor.stat, observed)) return false;
    }
    return true;
  }
  private async finish(): Promise<void> {
    await this.closeCursor();
    this.queue.length = 0;
    this.state.state = Object.values(this.state.issues).some(Boolean) ? 'incomplete' : 'complete';
    this.state.finishedAt = Date.now();
  }
  private async advance(): Promise<RuntimeInventorySnapshot> {
    this.state.pass = { entries: 0, nameBytes: 0 };
    const deadline = this.clock() + this.limits.passMs;
    try {
      if (!this.initialised) {
        this.initialised = true;
        const stat = await lstat(this.root);
        if (!stat.isDirectory() || stat.isSymbolicLink() || !privateEntry(stat)) {
          this.issue('unsafe');
          await this.finish();
          return this.snapshot();
        }
        this.queue.push({ relative: '', stat, ancestors: [] });
        this.state.directories++;
      }
      while (
        !this.stopping &&
        this.clock() < deadline &&
        this.state.pass.entries < this.limits.passEntries
      ) {
        if (!this.cursor) {
          const directory = this.queue.shift();
          if (!directory) {
            await this.finish();
            break;
          }
          if (!(await this.unchanged(directory))) {
            this.issue('changed');
            continue;
          }
          const handle = await opendir(join(this.root, directory.relative), { bufferSize: 1 });
          this.cursor = { directory, handle };
          if (!(await this.unchanged(directory))) {
            this.issue('changed');
            await this.closeCursor();
            continue;
          }
        }
        const { directory, handle } = this.cursor;
        if (!(await this.unchanged(directory))) {
          this.issue('changed');
          await this.closeCursor();
          continue;
        }
        const entry = this.cursor.pending ?? (await handle.read());
        delete this.cursor.pending;
        if (!entry) {
          await this.closeCursor();
          continue;
        }
        const relative = directory.relative ? `${directory.relative}/${entry.name}` : entry.name;
        const bytes = Buffer.byteLength(relative);
        if (
          bytes > this.limits.pathBytes ||
          bytes > this.limits.passNameBytes ||
          this.state.nameBytes + bytes > this.limits.nameBytes ||
          this.state.entries >= this.limits.entries
        ) {
          this.issue('limit');
          await this.finish();
          break;
        }
        if (this.state.pass.nameBytes + bytes > this.limits.passNameBytes) {
          this.cursor.pending = entry;
          break;
        }
        this.state.pass.entries++;
        this.state.pass.nameBytes += bytes;
        this.state.entries++;
        this.state.nameBytes += bytes;
        const stat = await lstat(join(this.root, relative));
        if (
          stat.isSymbolicLink() ||
          !privateEntry(stat) ||
          (!stat.isDirectory() && !stat.isFile()) ||
          (stat.isFile() && stat.nlink !== 1)
        ) {
          this.issue('unsafe');
          continue;
        }
        if (!(await this.unchanged(directory))) {
          this.issue('changed');
          await this.closeCursor();
          continue;
        }
        const category = runtimeStorageCategory(relative, stat.isDirectory());
        if (category === 'unknown') this.issue('unknown');
        if (stat.isDirectory()) {
          this.state.directories++;
          if (category === 'unknown') continue;
          if (
            this.state.directories > this.limits.directories ||
            directory.ancestors.length + 1 >= this.limits.depth
          ) {
            this.issue('limit');
            continue;
          }
          this.queue.push({ relative, stat, ancestors: [...directory.ancestors, directory] });
        } else {
          if (
            !Number.isSafeInteger(stat.size) ||
            stat.size < 0 ||
            !Number.isSafeInteger(this.state.bytes[category] + stat.size)
          ) {
            this.issue('limit');
            continue;
          }
          this.state.files++;
          this.state.bytes[category] += stat.size;
        }
      }
    } catch {
      this.issue('unavailable');
      await this.finish();
    }
    return this.snapshot();
  }
}
