import type { StatusPatterns } from '../agents/adapter.js';
import { stripAnsi } from './ansi.js';

export type DetectedStatus = 'running' | 'waiting_input';

/**
 * Global variants of the adapter's patterns, compiled once per detector —
 * `feed` runs on every PTY chunk, so per-call `new RegExp` is real CPU on a
 * chatty TUI. Sharing compiled instances is safe: matchAll works on a clone
 * and never mutates the source regex's lastIndex.
 */
function globalise(patterns: RegExp[]): RegExp[] {
  return patterns.map((re) =>
    re.flags.includes('g') ? re : new RegExp(re.source, re.flags + 'g'),
  );
}

/** Index of the last match of any pattern in `text`, or -1. */
function lastMatchIndex(patterns: RegExp[], text: string): number {
  let last = -1;
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      if (m.index > last) last = m.index;
    }
  }
  return last;
}

/**
 * Drives running ⇄ waiting_input from an agent PTY's output stream (SPEC §4):
 * any output means running; waiting_input is declared only after a
 * waitingInput pattern matches the ANSI-stripped tail and ~quietMs pass with
 * no further output. A busy pattern in the tail suppresses the transition.
 */
export class StatusDetector {
  private tail = '';
  private timer: NodeJS.Timeout | null = null;
  private last: DetectedStatus | null = null;
  private limitFired = false;
  private readonly busy: RegExp[];
  private readonly waiting: RegExp[];

  constructor(
    private readonly patterns: StatusPatterns,
    private readonly callbacks: {
      onStatus: (status: DetectedStatus) => void;
      onLimitReached?: () => void;
    },
    private readonly quietMs = 2000,
  ) {
    this.busy = globalise(patterns.busy ?? []);
    this.waiting = globalise(patterns.waitingInput);
  }

  feed(chunk: string): void {
    this.tail = (this.tail + stripAnsi(chunk)).slice(-2000);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emit('running');
    if (!this.limitFired && this.patterns.limitReached?.some((re) => re.test(this.tail)) === true) {
      this.limitFired = true;
      this.callbacks.onLimitReached?.();
    }
    // Position-based: an input-box match only counts if it appears AFTER the
    // last busy marker — TUIs leave stale "esc to interrupt" text in the
    // rolling tail long after the spinner cleared.
    const busyIdx = lastMatchIndex(this.busy, this.tail);
    const waitingIdx = lastMatchIndex(this.waiting, this.tail);
    if (waitingIdx > busyIdx) {
      this.timer = setTimeout(() => this.emit('waiting_input'), this.quietMs);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private emit(status: DetectedStatus): void {
    if (this.last === status) return;
    this.last = status;
    this.callbacks.onStatus(status);
  }
}
