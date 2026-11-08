export interface PendingCloseReview<T> {
  key: string;
  value: T;
  promise: Promise<boolean>;
  resolve(accepted: boolean): void;
  cleanups: Array<() => void>;
}

/** A user decision has no timeout; cancellation and unmount never authorise closure. */
export class CloseReview<T> {
  private pending: PendingCloseReview<T> | null = null;
  private readonly listeners = new Set<() => void>();
  get = () => this.pending;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  request(key: string, value: T, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted || (this.pending && this.pending.key !== key))
      return Promise.resolve(false);
    if (!this.pending) {
      let resolve!: (accepted: boolean) => void;
      const promise = new Promise<boolean>((done) => {
        resolve = done;
      });
      this.pending = { key, value, promise, resolve, cleanups: [] };
    }
    const pending = this.pending;
    if (signal) {
      const cancel = () => this.finish(pending, false);
      signal.addEventListener('abort', cancel, { once: true });
      pending.cleanups.push(() => signal.removeEventListener('abort', cancel));
    }
    for (const listener of this.listeners) listener();
    return pending.promise;
  }

  finish(pending: PendingCloseReview<T> | null, accepted: boolean): void {
    if (!pending || this.pending !== pending) return;
    this.pending = null;
    for (const cleanup of pending.cleanups) cleanup();
    pending.resolve(accepted);
    for (const listener of this.listeners) listener();
  }

  cancel = () => this.finish(this.pending, false);
}
