import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

/** How long appended chunks may sit in memory before hitting disk. */
const FLUSH_MS = 100;

/**
 * Append-only PTY output logs, one file per terminal:
 * logs/<session-id>/<term>.log (SPEC §2). Appends coalesce in memory and are
 * flushed on a short timer — a chatty TUI redrawing many times a second must
 * not cost a synchronous disk write per chunk (the disk never idles). The
 * buffered state is unobservable: readTail and close/closeAll flush first, so
 * replay and tests see every append, exactly as when writes were per-chunk.
 *
 * Files are capped at `maxBytes` (config `logMaxBytes`): on crossing the cap
 * a log is rewritten in place to its newest half — always at least the replay
 * window — so scrollback logs no longer grow without bound.
 */
export class LogStore {
  private readonly fds = new Map<string, number>();
  private readonly pending = new Map<string, string[]>();
  /** Bytes on disk per open log (tracked, not stat'ed per flush). */
  private readonly sizes = new Map<string, number>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly logsDir: string,
    private readonly replayBytes: number,
    private readonly maxBytes = 10 * 1024 * 1024,
  ) {}

  append(sessionId: string, term: string, data: string): void {
    const key = `${sessionId}/${term}`;
    const chunks = this.pending.get(key);
    if (chunks) chunks.push(data);
    else this.pending.set(key, [data]);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushAll(), FLUSH_MS);
      this.flushTimer.unref?.();
    }
  }

  close(sessionId: string, term: string): void {
    const key = `${sessionId}/${term}`;
    this.flush(key);
    const fd = this.fds.get(key);
    if (fd !== undefined) {
      closeSync(fd);
      this.fds.delete(key);
      this.sizes.delete(key);
    }
  }

  closeAll(): void {
    this.flushAll();
    for (const fd of this.fds.values()) closeSync(fd);
    this.fds.clear();
    this.sizes.clear();
  }

  /** Last `replayBytes` bytes (an initial multi-byte fragment is acceptable). */
  readTail(sessionId: string, term: string): string {
    this.flush(`${sessionId}/${term}`);
    const file = this.file(sessionId, term);
    if (!existsSync(file)) return '';
    const size = statSync(file).size;
    const start = Math.max(0, size - this.replayBytes);
    const length = size - start;
    if (length === 0) return '';
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, start);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  }

  /** Terminal ids that have recorded output for this session. */
  listTerms(sessionId: string): string[] {
    const dir = join(this.logsDir, sessionId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => f.slice(0, -'.log'.length));
  }

  /** Forces every buffered append to disk — for shutdown paths and tests
      that read the log files directly rather than via readTail. */
  flushAll(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const key of [...this.pending.keys()]) this.flush(key);
  }

  private flush(key: string): void {
    const chunks = this.pending.get(key);
    if (!chunks) return;
    this.pending.delete(key);
    const data = chunks.join('');
    const [sessionId, term] = this.split(key);
    let fd = this.fds.get(key);
    if (fd === undefined) {
      mkdirSync(join(this.logsDir, sessionId), { recursive: true });
      const file = this.file(sessionId, term);
      fd = openSync(file, 'a');
      this.fds.set(key, fd);
      this.sizes.set(key, statSync(file).size); // pre-existing bytes count towards the cap
    }
    writeSync(fd, data);
    const size = (this.sizes.get(key) ?? 0) + Buffer.byteLength(data);
    this.sizes.set(key, size);
    if (size > this.maxBytes) this.rotate(key, sessionId, term, size);
  }

  /**
   * Rewrites the log to its newest tail (half the cap, never less than the
   * replay window) via a temp file + rename, so a concurrent reader always
   * sees a complete file. Runs once per ~maxBytes/2 of output — amortised.
   */
  private rotate(key: string, sessionId: string, term: string, size: number): void {
    const file = this.file(sessionId, term);
    const keep = Math.min(size, Math.max(this.replayBytes, Math.floor(this.maxBytes / 2)));
    const fd = this.fds.get(key);
    if (fd === undefined) return;
    // The append fd is write-only — the tail must be read through its own fd.
    const buf = Buffer.alloc(keep);
    const readFd = openSync(file, 'r');
    let read: number;
    try {
      read = readSync(readFd, buf, 0, keep, size - keep);
    } finally {
      closeSync(readFd);
    }
    closeSync(fd);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, buf.subarray(0, read));
    renameSync(tmp, file);
    this.fds.set(key, openSync(file, 'a'));
    this.sizes.set(key, read);
  }

  private split(key: string): [string, string] {
    const slash = key.indexOf('/');
    return [key.slice(0, slash), key.slice(slash + 1)];
  }

  private file(sessionId: string, term: string): string {
    return join(this.logsDir, sessionId, `${term}.log`);
  }
}
