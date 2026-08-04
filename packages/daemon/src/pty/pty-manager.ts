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
 * The size a PTY starts at when no viewer has ever sized this (stream, term) —
 * a plausible terminal, not the one on screen (nothing is attached yet).
 */
const DEFAULT_SIZE = { cols: 120, rows: 32 } as const;

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
  /**
   * The last size a viewer asked for, per (stream, term) — kept whether or not a
   * PTY is live so the NEXT one starts at it. A resume or an account migration
   * replaces the PTY under an attached viewer, and nothing re-sends the size
   * then: the viewer is already attached (no fresh `attach`) and its container
   * has not changed (no resize), so a fixed default left the agent rendering to
   * a screen that wasn't there — a TUI wrapped or short of the pane it sits in.
   */
  private readonly sizes = new Map<string, { cols: number; rows: number }>();

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
    const size = this.sizes.get(key) ?? DEFAULT_SIZE;
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
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

  /**
   * Size a PTY, remembering the size for whatever PTY takes this (stream, term)
   * next — a resize that arrives while nothing is live (a viewer attached to an
   * exited session) is therefore not lost, it just applies to the resume.
   */
  resize(stream: string, term: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.sizes.set(this.key(stream, term), { cols, rows });
    try {
      this.live.get(this.key(stream, term))?.proc.resize(cols, rows);
    } catch {
      // Resizing a PTY that exited between lookup and call is harmless.
    }
  }

  /**
   * Drop the remembered sizes for a stream — its session is gone for good, so no
   * later PTY can want them (an archive is NOT gone: it resumes at its size).
   */
  forget(stream: string): void {
    const prefix = `${stream} `;
    for (const key of [...this.sizes.keys()]) if (key.startsWith(prefix)) this.sizes.delete(key);
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
