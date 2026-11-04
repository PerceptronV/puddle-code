import { ApiError } from '../../http/errors.js';

const unavailable = () =>
  new ApiError(
    503,
    'host_maintenance',
    'The host is pausing requests for maintenance; inspect the outcome before retrying a write.',
  );

/** Client admission only: draining requests is not proof that background writers are quiescent. */
export class HostAdmission {
  private held = false;
  private closed = false;
  private active = 0;
  private readonly changed = new Set<() => void>();

  assertOpen(): void {
    if (this.held || this.closed) throw unavailable();
  }

  enter(): () => void {
    this.assertOpen();
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.notify();
    };
  }

  async run<T>(action: () => Promise<T>): Promise<T> {
    const release = this.enter();
    try {
      return await action();
    } finally {
      release();
    }
  }

  /** A single coordinator holds the pause; a stale release cannot reopen a later hold. */
  pause(): { drain(timeoutMs?: number): Promise<void>; release(): void } {
    this.assertOpen();
    this.held = true;
    let released = false;
    return {
      drain: (timeoutMs = 30_000) => this.wait(timeoutMs, () => !released),
      release: () => {
        if (released) return;
        released = true;
        this.held = false;
        this.notify();
      },
    };
  }

  /** Shutdown is irreversible even when a preceding coordinator releases its pause. */
  close(): void {
    this.closed = true;
    this.notify();
  }

  drain(timeoutMs = 30_000): Promise<void> {
    if (!this.closed) throw new Error('Close admission or hold a pause before draining');
    return this.wait(timeoutMs, () => this.closed);
  }

  private wait(timeoutMs: number, valid: () => boolean): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)
      return Promise.reject(new Error('Invalid admission drain deadline'));
    if (this.changed.size >= 8) return Promise.reject(new Error('Too many admission waiters'));
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.changed.delete(check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (!valid()) finish(new Error('Admission pause was released before draining'));
        else if (this.active === 0) finish();
      };
      const timer = setTimeout(
        () => finish(new Error('Host requests did not drain before the deadline')),
        timeoutMs,
      );
      timer.unref();
      this.changed.add(check);
      check();
    });
  }

  private notify(): void {
    for (const check of [...this.changed]) check();
  }
}
