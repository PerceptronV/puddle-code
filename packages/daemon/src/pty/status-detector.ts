import type { StatusPatterns } from '../agents/adapter.js';
import { stripAnsi } from './ansi.js';

export type DetectedStatus = 'running' | 'waiting_input';

/** Index of the last match of any pattern in `text`, or -1. */
function lastMatchIndex(patterns: RegExp[], text: string): number {
  let last = -1;
  for (const re of patterns) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of text.matchAll(global)) {
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

  constructor(
    private readonly patterns: StatusPatterns,
    private readonly callbacks: {
      onStatus: (status: DetectedStatus) => void;
      onLimitReached?: () => void;
    },
    private readonly quietMs = 2000,
  ) {}

  feed(chunk: string): void {
    this.tail = (this.tail + stripAnsi(chunk)).slice(-2000);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emit('running');
    if (
      !this.limitFired &&
      this.patterns.limitReached?.some((re) => re.test(this.tail)) === true
    ) {
      this.limitFired = true;
      this.callbacks.onLimitReached?.();
    }
    // Position-based: an input-box match only counts if it appears AFTER the
    // last busy marker — TUIs leave stale "esc to interrupt" text in the
    // rolling tail long after the spinner cleared.
    const busyIdx = lastMatchIndex(this.patterns.busy ?? [], this.tail);
    const waitingIdx = lastMatchIndex(this.patterns.waitingInput, this.tail);
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
