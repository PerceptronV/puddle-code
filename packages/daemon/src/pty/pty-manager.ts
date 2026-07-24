import { EventEmitter } from 'node:events';
import pty from 'node-pty';
import type { LogStore } from '../logs/log-store.js';
import { EnvOscFilter, type EnvDelta } from './env-osc.js';

export interface PtyDataEvent {
  stream: string;
  term: string;
  data: string;
}

export interface PtyExitEvent {
  stream: string;
  term: string;
  exitCode: number;
}

/** A captured-env report parsed (and stripped) from a PTY's OSC 7733 side-channel. */
export interface PtyEnvDeltaEvent {
  stream: string;
  term: string;
  delta: EnvDelta;
}

interface Live {
  proc: pty.IPty;
  record: boolean;
  filter: EnvOscFilter;
}

/**
 * Owns every live PTY, keyed by (stream, term) where stream is a session id
 * or `login-<accountId>`. Tees recorded output to the LogStore. Emits
 * 'data' (PtyDataEvent), 'exit' (PtyExitEvent), and 'env-delta'
 * (PtyEnvDeltaEvent). A PTY has exactly one size — the most recent
 * attach/resize wins (SPEC §6). Every PTY's output passes through an
 * EnvOscFilter, so OSC 7733 payloads (captured env, potential secrets) are
 * stripped before any log write or 'data' emit.
 */
export class PtyManager extends EventEmitter {
  private readonly live = new Map<string, Live>();

  constructor(private readonly logs: LogStore) {
    super();
  }

  spawn(
    stream: string,
    term: string,
    file: string,
    args: string[],
    opts: { cwd: string; env?: Record<string, string>; record?: boolean },
  ): void {
    const key = this.key(stream, term);
    if (this.live.has(key)) throw new Error(`pty ${key} already live`);
    const record = opts.record ?? true;
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env } as Record<string, string>,
    });
    const filter = new EnvOscFilter();
    this.live.set(key, { proc, record, filter });
    proc.onData((raw) => {
      const { data, deltas } = filter.push(raw);
      for (const delta of deltas) {
        this.emit('env-delta', { stream, term, delta } satisfies PtyEnvDeltaEvent);
      }
      if (data === '') return; // chunk fully swallowed by the side-channel
      if (record) this.logs.append(stream, term, data);
      this.emit('data', { stream, term, data } satisfies PtyDataEvent);
    });
    proc.onExit(({ exitCode }) => {
      if (record) this.logs.close(stream, term);
      this.live.delete(key);
      this.emit('exit', { stream, term, exitCode } satisfies PtyExitEvent);
    });
  }

  write(stream: string, term: string, data: string): void {
    this.live.get(this.key(stream, term))?.proc.write(data);
  }

  resize(stream: string, term: string, cols: number, rows: number): void {
    try {
      this.live.get(this.key(stream, term))?.proc.resize(cols, rows);
    } catch {
      // Resizing a PTY that exited between lookup and call is harmless.
    }
  }

  kill(stream: string, term: string, signal?: string): boolean {
    const rec = this.live.get(this.key(stream, term));
    if (!rec) return false;
    rec.proc.kill(signal);
    return true;
  }

  killAll(stream?: string, signal?: string): void {
    for (const [key, rec] of this.live) {
      if (stream === undefined || key.startsWith(`${stream} `)) rec.proc.kill(signal);
    }
  }

  has(stream: string, term: string): boolean {
    return this.live.has(this.key(stream, term));
  }

  liveCount(): number {
    return this.live.size;
  }

  liveTerms(stream: string): string[] {
    const prefix = `${stream} `;
    return [...this.live.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }

  /** OS pids of every live PTY on a stream (agent + shell-N terms). */
  pidsFor(stream: string): number[] {
    const prefix = `${stream} `;
    return [...this.live.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, rec]) => rec.proc.pid);
  }

  /**
   * Daemon-injected terminal line (e.g. "skip-permissions not permitted"):
   * recorded in the log and broadcast like PTY output, without touching stdin.
   */
  note(stream: string, term: string, text: string): void {
    const data = `\r\n[puddle] ${text}\r\n`;
    this.logs.append(stream, term, data);
    this.emit('data', { stream, term, data } satisfies PtyDataEvent);
  }

  private key(stream: string, term: string): string {
    return `${stream} ${term}`;
  }
}
