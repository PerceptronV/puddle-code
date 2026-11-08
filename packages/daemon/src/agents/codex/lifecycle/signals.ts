import type { LifecycleLaunchContext } from '../../adapter.js';
import type { RuntimeBufferBudget } from '../../../runtime/resources/budget.js';
import { agentSignalRequestSchema } from '@puddle/shared';

interface Job {
  body: string;
  essential: boolean;
  release(): void;
}

/** Ordered identity delivery; only adjacent waiting status observations may coalesce. */
export class CodexSignalQueue {
  private readonly jobs: Job[] = [];
  private active = false;
  private closed = false;
  private unavailable = false;
  private readonly abort = new AbortController();
  private done: (() => void) | null = null;
  settled = Promise.resolve();

  get available(): boolean {
    return !this.closed && !this.unavailable;
  }

  constructor(
    private readonly context: LifecycleLaunchContext,
    private readonly budget: RuntimeBufferBudget,
  ) {}

  enqueue(body: string, essential: boolean): boolean {
    if (this.closed || this.unavailable) return false;
    const accepted = this.admit([{ body, essential }]);
    if (!accepted && essential) this.fail();
    return accepted;
  }

  /** Atomic unsent batch admission; denied credit alone never loses native identity. */
  admit(input: ReadonlyArray<{ body: string; essential: boolean }>): boolean {
    if (this.closed || this.unavailable) return true;
    const planned: Array<{ body: string; essential: boolean }> = [];
    for (const item of input) {
      if (!item.essential && planned.at(-1)?.essential === false) planned.pop();
      planned.push(item);
    }
    const admitted: Job[] = [];
    for (const item of planned) {
      const release = this.budget.reserve(4 * Buffer.byteLength(item.body) + 512);
      if (!release) {
        if (!item.essential) continue;
        for (const job of admitted) job.release();
        return false;
      }
      admitted.push({ ...item, release });
    }
    for (const job of admitted) {
      const last = this.jobs.at(-1);
      if (!job.essential && last?.essential === false) {
        this.jobs.pop();
        last.release();
      }
      this.jobs.push(job);
    }
    if (!this.active && this.jobs.length) {
      this.active = true;
      this.settled = new Promise<void>((resolve) => {
        this.done = resolve;
      });
      void this.drain();
    }
    return true;
  }

  fail(): void {
    if (this.unavailable) return;
    this.unavailable = true;
    this.context.reportLifecycleUnavailable?.();
    for (const job of this.jobs.splice(0)) job.release();
  }

  close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    for (const job of this.jobs.splice(0)) job.release();
    return this.settled;
  }

  private async drain(): Promise<void> {
    try {
      while (!this.closed && !this.unavailable) {
        const job = this.jobs.shift();
        if (!job) break;
        try {
          if (this.context.receiveSignal) {
            const signal = agentSignalRequestSchema.parse(JSON.parse(job.body));
            if (!this.context.receiveSignal(signal) && job.essential) this.fail();
            continue;
          }
          const response = await fetch(this.context.signalUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: job.body,
            signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(1500)]),
          });
          // The local hook has no response body; release any unexpected body without buffering it.
          await response.body?.cancel();
          if (job.essential && !response.ok) this.fail();
        } catch {
          if (job.essential && !this.closed) this.fail();
        } finally {
          job.release();
        }
      }
    } finally {
      this.active = false;
      this.done?.();
      this.done = null;
    }
  }
}
