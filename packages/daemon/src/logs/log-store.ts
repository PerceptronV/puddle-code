import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { isStorageFull } from '../storage/errors.js';
import type { RuntimeByteAllowance } from '../runtime/resources/budget.js';

const FLUSH_MS = 100;
const PER_TERM_BYTES = 256 * 1024;
const TOTAL_PENDING_BYTES = 8 * 1024 * 1024;
const ENCODE_UNITS = 16 * 1024;
const empty = Buffer.alloc(0);
const uncharged = () => {};
interface PendingLog {
  buffer: Buffer;
  offset: number;
  release: () => void;
}

/** Bounded, best-effort terminal history. Live PTY delivery never depends on saving it. */
export class LogStore {
  private readonly fds = new Map<string, number>();
  private readonly pending = new Map<string, PendingLog>();
  private readonly sizes = new Map<string, number>();
  private pendingBytes = 0;
  private readonly closed = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private retryAt = 0;
  private retryMs = 1000;
  private failed = false;

  constructor(
    private readonly logsDir: string,
    private readonly replayBytes: number,
    private readonly maxBytes = 10 * 1024 * 1024,
    private readonly onHealth?: (degraded: boolean) => void,
    private readonly allowance?: RuntimeByteAllowance,
  ) {}

  /** Exposed for diagnostics: includes every unsaved terminal, even after PTY exit. */
  bufferedBytes(): number {
    return this.pendingBytes;
  }

  /** Retention must not replace a descriptor used by live or pending output. */
  isOpen(sessionId: string, term: string): boolean {
    const key = `${sessionId}/${term}`;
    return this.fds.has(key) || this.pending.has(key);
  }

  append(sessionId: string, term: string, data: string): void {
    const key = `${sessionId}/${term}`;
    this.closed.delete(key);
    try {
      for (let offset = 0; offset < data.length;) {
        let end = Math.min(data.length, offset + ENCODE_UNITS);
        // Do not turn a pair straddling our internal chunk boundary into replacements.
        const last = data.charCodeAt(end - 1);
        if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
        const units = end - offset;
        if (
          !this.failed &&
          (this.pendingLength(key) + 3 * units > PER_TERM_BYTES ||
            this.pendingBytes + 3 * units > TOTAL_PENDING_BYTES)
        )
          this.flushAll();
        // UTF-8 needs at most three bytes per UTF-16 unit; the bounded slice
        // can retain two more. Reserve before creating either allocation.
        const release = this.reserve(5 * units);
        try {
          const chunk = data.slice(offset, end);
          const incoming = Buffer.allocUnsafeSlow(3 * units);
          const bytes = incoming.write(chunk, 'utf8');
          this.queue(key, incoming.subarray(0, bytes));
        } finally {
          release();
        }
        offset = end;
      }
    } catch (error) {
      this.degrade(error);
    }
    this.schedule();
  }

  private reserve(bytes: number): () => void {
    if (!this.allowance || bytes === 0) return uncharged;
    const release = this.allowance.reserve(bytes);
    if (!release) throw new Error('Terminal history memory allowance is unavailable');
    return release;
  }

  private pendingLength(key: string): number {
    const data = this.pending.get(key);
    return data ? data.buffer.length - data.offset : 0;
  }

  private queue(key: string, incoming: Buffer): void {
    const previous = this.pending.get(key);
    const previousLength = previous ? previous.buffer.length - previous.offset : 0;
    const length = Math.min(PER_TERM_BYTES, previousLength + incoming.length);
    const release = this.reserve(length);
    try {
      // Unpooled buffers keep the reserved capacity equal to their retained backing.
      const tail = Buffer.allocUnsafeSlow(length);
      const fromPrevious = Math.min(previousLength, length - Math.min(length, incoming.length));
      if (fromPrevious) previous!.buffer.copy(tail, 0, previous!.buffer.length - fromPrevious);
      incoming.copy(tail, fromPrevious, Math.max(0, incoming.length - length));
      this.setPending(key, { buffer: tail, offset: 0, release });
    } catch (error) {
      release();
      throw error;
    }
    while (this.pendingBytes > TOTAL_PENDING_BYTES) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.setPending(oldest, null);
    }
  }

  close(sessionId: string, term: string): void {
    const key = `${sessionId}/${term}`;
    this.flushAll();
    this.closeFd(key);
    if (this.pending.has(key)) this.closed.add(key);
    // A failed flush retains only bounded history and retries without retaining a PTY.
  }

  closeAll(): void {
    this.flushAll();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const key of this.fds.keys()) this.closeFd(key);
  }

  readTail(sessionId: string, term: string): string {
    const key = `${sessionId}/${term}`;
    this.flushAll();
    const queued = this.pending.get(key);
    const pending = queued ? queued.buffer.subarray(queued.offset) : empty;
    const file = this.file(sessionId, term);
    let release: (() => void) | undefined;
    try {
      const size = existsSync(file) ? statSync(file).size : 0;
      const fromPending = Math.min(this.replayBytes, pending.length);
      const fromDisk = Math.min(size, this.replayBytes - fromPending);
      // One exact buffer plus the worst-case UTF-16 result, not two concatenated buffers.
      release = this.reserve(3 * (fromDisk + fromPending));
      const buf = Buffer.allocUnsafeSlow(fromDisk + fromPending);
      let read = 0;
      if (fromDisk) {
        const fd = openSync(file, 'r');
        try {
          while (read < fromDisk) {
            const count = readSync(fd, buf, read, fromDisk - read, size - fromDisk + read);
            if (!count) break;
            read += count;
          }
        } finally {
          closeSync(fd);
        }
      }
      pending.copy(buf, read, pending.length - fromPending);
      return buf.subarray(0, read + fromPending).toString('utf8');
    } catch (error) {
      this.degrade(error);
      this.schedule();
      return '';
    } finally {
      release?.();
    }
  }

  listTerms(sessionId: string): string[] {
    const dir = join(this.logsDir, sessionId);
    const disk = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.log'))
          .map((f) => f.slice(0, -4))
      : [];
    const memory = [...this.pending.keys()]
      .filter((key) => key.startsWith(`${sessionId}/`))
      .map((key) => this.split(key)[1]);
    return [...new Set([...disk, ...memory])];
  }

  historyFile(sessionId: string): string {
    const dir = join(this.logsDir, sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, 'shell-history');
  }

  flushAll(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (Date.now() < this.retryAt) {
      this.schedule();
      return;
    }
    for (const key of this.pending.keys()) {
      try {
        this.flush(key);
      } catch (error) {
        this.closeFd(key);
        this.degrade(error);
        this.schedule();
        return;
      }
    }
    if (this.failed) {
      this.failed = false;
      this.notifyHealth(false);
    }
    this.retryAt = 0;
    this.retryMs = 1000;
  }

  private schedule(): void {
    if (this.flushTimer || this.pending.size === 0) return;
    this.flushTimer = setTimeout(
      () => this.flushAll(),
      Math.max(FLUSH_MS, this.retryAt - Date.now()),
    );
    this.flushTimer.unref?.();
  }

  private notifyHealth(degraded: boolean): void {
    try {
      this.onHealth?.(degraded);
    } catch {
      /* Observers must not stop live PTY delivery or history cleanup. */
    }
  }

  private degrade(error: unknown): void {
    if (!this.failed) {
      this.failed = true;
      this.notifyHealth(true);
      console.warn(
        'Terminal history is temporarily not being saved:',
        isStorageFull(error) ? 'storage full' : error,
      );
    }
    this.retryAt = Date.now() + this.retryMs;
    this.retryMs = Math.min(30_000, this.retryMs * 2);
  }

  private setPending(key: string, data: PendingLog | null): void {
    const previous = this.pending.get(key);
    this.pendingBytes -= this.pendingLength(key);
    this.pending.delete(key);
    previous?.release();
    if (data === null && this.closed.delete(key)) this.closeFd(key);
    if (data !== null) {
      this.pending.set(key, data);
      this.pendingBytes += data.buffer.length - data.offset;
    }
  }

  private flush(key: string): void {
    const data = this.pending.get(key);
    if (!data) return;
    const [sessionId, term] = this.split(key);
    let fd = this.fds.get(key);
    if (fd === undefined) {
      mkdirSync(join(this.logsDir, sessionId), { recursive: true, mode: 0o700 });
      fd = openSync(this.file(sessionId, term), 'a', 0o600);
      this.fds.set(key, fd);
      this.sizes.set(key, statSync(this.file(sessionId, term)).size);
    }
    // Recover a failed rotation before writing more, including an empty retry marker.
    if ((this.sizes.get(key) ?? 0) > this.maxBytes) {
      this.rotate(key, sessionId, term);
      fd = this.fds.get(key)!;
    }
    let written = 0;
    try {
      while (written < data.buffer.length - data.offset) {
        const count = writeSync(
          fd,
          data.buffer,
          data.offset + written,
          data.buffer.length - data.offset - written,
        );
        if (count === 0) throw new Error('Terminal log write made no progress');
        written += count;
        this.sizes.set(key, (this.sizes.get(key) ?? 0) + count);
      }
    } finally {
      // Short writes followed by ENOSPC must not duplicate their successful prefix.
      data.offset += written;
      this.pendingBytes -= written;
    }
    if ((this.sizes.get(key) ?? 0) > this.maxBytes) this.rotate(key, sessionId, term);
    this.setPending(key, null);
  }

  private rotate(key: string, sessionId: string, term: string): void {
    const file = this.file(sessionId, term);
    const size = this.sizes.get(key) ?? 0;
    const keep = Math.min(size, Math.max(this.replayBytes, Math.floor(this.maxBytes / 2)));
    const release = this.reserve(keep);
    try {
      const buf = Buffer.allocUnsafeSlow(keep);
      const readFd = openSync(file, 'r');
      let read = 0;
      try {
        while (read < keep) {
          const count = readSync(readFd, buf, read, keep - read, size - keep + read);
          if (!count) throw new Error('Terminal log rotation read made no progress');
          read += count;
        }
      } finally {
        closeSync(readFd);
      }
      const tmp = `${file}.tmp-${process.pid}`;
      try {
        writeFileSync(tmp, buf.subarray(0, read), { mode: 0o600 });
        this.closeFd(key);
        renameSync(tmp, file);
        this.fds.set(key, openSync(file, 'a', 0o600));
        this.sizes.set(key, read);
      } finally {
        try {
          unlinkSync(tmp);
        } catch {
          /* Absent after rename, or disk unavailable. */
        }
      }
    } finally {
      release();
    }
  }

  private closeFd(key: string): void {
    const fd = this.fds.get(key);
    this.fds.delete(key);
    this.sizes.delete(key);
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* Log cleanup must never stop PTY cleanup. */
      }
    }
  }

  private split(key: string): [string, string] {
    const slash = key.indexOf('/');
    return [key.slice(0, slash), key.slice(slash + 1)];
  }

  private file(sessionId: string, term: string): string {
    return join(this.logsDir, sessionId, `${term}.log`);
  }
}
