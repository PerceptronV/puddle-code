import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Append-only PTY output logs, one file per terminal:
 * logs/<session-id>/<term>.log (SPEC §2). Writes are synchronous on an open
 * fd — PTY chunks are small, and replay/tests must never observe a torn or
 * buffered state. Replay serves the last `replayBytes` bytes verbatim.
 */
export class LogStore {
  private readonly fds = new Map<string, number>();

  constructor(
    private readonly logsDir: string,
    private readonly replayBytes: number,
  ) {}

  append(sessionId: string, term: string, data: string): void {
    const key = `${sessionId}/${term}`;
    let fd = this.fds.get(key);
    if (fd === undefined) {
      mkdirSync(join(this.logsDir, sessionId), { recursive: true });
      fd = openSync(this.file(sessionId, term), 'a');
      this.fds.set(key, fd);
    }
    writeSync(fd, data);
  }

  close(sessionId: string, term: string): void {
    const key = `${sessionId}/${term}`;
    const fd = this.fds.get(key);
    if (fd !== undefined) {
      closeSync(fd);
      this.fds.delete(key);
    }
  }

  closeAll(): void {
    for (const fd of this.fds.values()) closeSync(fd);
    this.fds.clear();
  }

  /** Last `replayBytes` bytes (an initial multi-byte fragment is acceptable). */
  readTail(sessionId: string, term: string): string {
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

  private file(sessionId: string, term: string): string {
    return join(this.logsDir, sessionId, `${term}.log`);
  }
}
