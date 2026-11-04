import { HostAdmission } from '../host/lifecycle/admission.js';
import { TerminalLogCompactor } from './retention/compactor.js';
import {
  emptyRetentionResult,
  type LogRetentionOptions,
  type LogRetentionResult,
} from './retention/types.js';
export type { LogRetentionOptions, LogRetentionResult } from './retention/types.js';

/** One bounded slice. Long-lived maintenance reuses TerminalLogCompactor to continue fairly. */
export async function compactTerminalLogs(
  options: LogRetentionOptions,
): Promise<LogRetentionResult> {
  const compactor = new TerminalLogCompactor();
  try {
    return await compactor.sweep(options);
  } finally {
    await compactor.close();
  }
}

/** Coalesce upkeep; shutdown waits for the bounded in-flight copy to leave the filesystem. */
export class LogRetention {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<LogRetentionResult> | null = null;
  private stopped = false;
  private paused = false;
  private readonly admission = new HostAdmission();
  private readonly compactor = new TerminalLogCompactor();
  private started = false;
  constructor(private readonly options: () => Omit<LogRetentionOptions, 'stopped'>) {}
  start(): void {
    this.admission.assertOpen();
    if (this.started) return;
    this.started = true;
    this.scheduledSweep();
  }
  private scheduledSweep(): void {
    if (this.stopped) return;
    void this.sweep().then(
      (result) => this.schedule(result.complete ? 60 * 60 * 1000 : 60_000),
      (error: unknown) => {
        console.warn('Terminal log retention failed:', error);
        this.schedule(60 * 60 * 1000);
      },
    );
  }
  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduledSweep();
    }, delay);
    this.timer.unref();
  }
  sweep(): Promise<LogRetentionResult> {
    if (this.stopped || this.paused) return Promise.resolve(emptyRetentionResult(!this.paused));
    if (!this.running)
      this.running = this.admission.run(() =>
        Promise.resolve()
          .then(() =>
            this.compactor.sweep({
              ...this.options(),
              stopped: () => this.stopped || this.paused,
            }),
          )
          .finally(() => {
            this.running = null;
          }),
      );
    return this.running;
  }
  pause(): ReturnType<HostAdmission['pause']> {
    const hold = this.admission.pause();
    this.paused = true;
    let released = false;
    return {
      drain: hold.drain,
      release: () => {
        if (released) return;
        released = true;
        this.paused = false;
        hold.release();
      },
    };
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    this.admission.close();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
    await this.admission.drain();
    await this.compactor.close();
  }
}
