import { RuntimeBufferBudget } from '../../runtime/resources/budget.js';
import { SCREEN_LIMITS } from './limits.js';

/** Only bounded metadata waiters: callers serialise after acquiring a slot. */
export class ScreenSnapshotWork {
  private readonly waiting: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
  }> = [];
  constructor(
    readonly budget = new RuntimeBufferBudget({
      bytes: SCREEN_LIMITS.transientBytes,
      count: SCREEN_LIMITS.transientOperations,
    }),
  ) {}

  tryAcquire(): (() => void) | null {
    const release = this.budget.reserve(SCREEN_LIMITS.operationBytes);
    if (!release) return null;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      release();
      this.wake();
    };
  }

  acquire(): Promise<() => void> {
    const release = this.tryAcquire();
    if (release) return Promise.resolve(release);
    if (this.budget.usedCount === 0 || this.waiting.length >= SCREEN_LIMITS.waitingOperations)
      return Promise.reject(new Error('Terminal snapshot work capacity exceeded'));
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  private wake(): void {
    while (this.waiting.length) {
      const reservation = this.tryAcquire();
      if (reservation) this.waiting.shift()!.resolve(reservation);
      else {
        // Remaining local work may free a slot. With no local holder, waiting
        // for a global allowance change would strand these promises forever.
        if (this.budget.usedCount === 0)
          for (const waiter of this.waiting.splice(0))
            waiter.reject(new Error('Terminal snapshot enclosing capacity exhausted'));
        return;
      }
    }
  }
}
