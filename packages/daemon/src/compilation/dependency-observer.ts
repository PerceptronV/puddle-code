import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

const CONCURRENCY = 8;
const VERIFY_MS = 10_000;
const SOURCE_VERIFY_MS = 1000;
const FALLBACK_MS = 500;
const WATCH_RETRY_MS = 5000;
const WATCH_RENEW_MS = 60_000;
type Listener = () => void;
interface FileObservation {
  path: string;
  directory: DirectoryObservation;
  listeners: Set<Listener>;
  sourceListeners: Set<Listener>;
  value?: string;
  due: number;
  reading: boolean;
  again: boolean;
  eventNotified: boolean;
  ready: Promise<void>;
  initialized: () => void;
}
interface DirectoryObservation {
  path: string;
  files: Set<FileObservation>;
  watcher: FSWatcher | null;
  retryAt: number;
  renewAt: number;
}

/** One service-owned observation per dependency path and directory, shared across targets. */
export class DependencyObserver {
  private readonly files = new Map<string, FileObservation>();
  private readonly directories = new Map<string, DirectoryObservation>();
  private readonly queued = new Set<FileObservation>();
  private active = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  subscribe(
    paths: readonly string[],
    changed: Listener,
    sources: readonly string[] = [],
  ): { ready: Promise<void>; close: () => void } {
    if (this.disposed) return { ready: Promise.resolve(), close: () => undefined };
    // Each registration has its own identity even when the caller reuses a callback.
    const listener = () => changed();
    const sourcePaths = new Set(sources);
    const retained = new Set<FileObservation>();
    for (const path of paths) {
      let file = this.files.get(path);
      if (!file) {
        const directoryPath = dirname(path);
        let directory = this.directories.get(directoryPath);
        if (!directory) {
          directory = {
            path: directoryPath,
            files: new Set(),
            watcher: null,
            retryAt: 0,
            renewAt: 0,
          };
          this.directories.set(directoryPath, directory);
          this.attach(directory);
        }
        let initialized!: () => void;
        const ready = new Promise<void>((resolve) => (initialized = resolve));
        file = {
          path,
          directory,
          listeners: new Set(),
          sourceListeners: new Set(),
          due: 0,
          reading: false,
          again: false,
          eventNotified: false,
          ready,
          initialized,
        };
        directory.files.add(file);
        this.files.set(path, file);
        this.enqueue(file);
      }
      file.listeners.add(listener);
      if (sourcePaths.has(path)) {
        file.sourceListeners.add(listener);
        file.due = Math.min(file.due, Date.now() + SOURCE_VERIFY_MS);
      }
      retained.add(file);
    }
    if (this.files.size && !this.timer) {
      this.timer = setInterval(() => this.tick(), FALLBACK_MS);
      this.timer.unref();
    }
    return {
      ready: Promise.all([...retained].map((file) => file.ready)).then(() => undefined),
      close: () => {
        for (const file of retained) {
          file.listeners.delete(listener);
          file.sourceListeners.delete(listener);
          if (file.listeners.size || this.files.get(file.path) !== file) continue;
          this.files.delete(file.path);
          this.queued.delete(file);
          file.initialized();
          const directory = file.directory;
          directory.files.delete(file);
          if (!directory.files.size) {
            directory.watcher?.close();
            this.directories.delete(directory.path);
          }
        }
        retained.clear();
        if (!this.files.size) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
      },
    };
  }

  /** A successful daemon write must not depend on delivery of an OS watch event. */
  invalidate(path: string): void {
    const file = this.files.get(path);
    if (!file || this.disposed) return;
    file.eventNotified = true;
    for (const listener of file.listeners) listener();
    this.enqueue(file);
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const directory of this.directories.values()) directory.watcher?.close();
    for (const file of this.files.values()) file.initialized();
    this.files.clear();
    this.directories.clear();
    this.queued.clear();
  }

  private attach(directory: DirectoryObservation): void {
    directory.watcher?.close();
    directory.watcher = null;
    directory.retryAt = Date.now() + WATCH_RETRY_MS;
    try {
      const watcher = watch(directory.path, (_event, filename) => {
        if (directory.watcher !== watcher) return;
        for (const file of directory.files) {
          if (filename !== null && filename.toString() !== basename(file.path)) continue;
          // Watch events are authoritative invalidations even when coarse
          // timestamps cannot distinguish two writes. Stats update the baseline.
          this.invalidate(file.path);
        }
      });
      directory.watcher = watcher;
      directory.renewAt = Date.now() + WATCH_RENEW_MS;
      watcher.on('error', () => {
        watcher.close();
        if (directory.watcher !== watcher) return;
        directory.watcher = null;
        directory.retryAt = Date.now() + WATCH_RETRY_MS;
        for (const file of directory.files) file.due = Math.min(file.due, Date.now() + FALLBACK_MS);
      });
    } catch {
      /* Missing directory / descriptor exhaustion: bounded polling remains active. */
    }
  }

  private tick(): void {
    const now = Date.now();
    for (const directory of this.directories.values()) {
      // Periodic renewal also replaces watches still bound to a removed inode.
      if (directory.watcher ? now >= directory.renewAt : now >= directory.retryAt)
        this.attach(directory);
    }
    for (const file of this.files.values())
      if (now >= file.due && !file.reading) this.enqueue(file);
  }

  private enqueue(file: FileObservation): void {
    if (this.files.get(file.path) !== file || this.disposed) return;
    if (file.reading) {
      file.again = true;
      return;
    }
    this.queued.add(file);
    this.pump();
  }

  private pump(): void {
    while (this.active < CONCURRENCY && this.queued.size) {
      const file = this.queued.values().next().value!;
      this.queued.delete(file);
      file.reading = true;
      this.active++;
      void this.read(file).finally(() => {
        file.reading = false;
        this.active--;
        file.initialized();
        if (file.again) {
          file.again = false;
          this.enqueue(file);
        }
        this.pump();
      });
    }
  }

  private async read(file: FileObservation): Promise<void> {
    const value = await signature(file.path);
    if (this.files.get(file.path) !== file || this.disposed) return;
    const changed = file.value !== undefined && file.value !== value;
    file.value = value;
    file.due =
      Date.now() +
      (file.directory.watcher
        ? file.sourceListeners.size
          ? SOURCE_VERIFY_MS
          : VERIFY_MS
        : FALLBACK_MS);
    if (changed && !file.eventNotified) for (const listener of file.listeners) listener();
    file.eventNotified = false;
  }
}

async function signature(path: string): Promise<string> {
  try {
    const value = await stat(path);
    return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
  } catch {
    return 'missing';
  }
}
