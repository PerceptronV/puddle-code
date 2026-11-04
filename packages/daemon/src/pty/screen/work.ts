import { RuntimeBufferBudget } from '../../runtime/resources/budget.js';
import { SCREEN_LIMITS } from './limits.js';

/** Only bounded metadata waiters: callers serialise after acquiring a slot. */
export class ScreenSnapshotWork {
  private pumping = false;
  private wakeAgain = false;
  private readonly waiting: Array<{
    deadline: number;
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
    if (this.waiting.length >= SCREEN_LIMITS.waitingOperations)
      return Promise.reject(new Error('Terminal snapshot work capacity exceeded'));
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject, deadline: performance.now() + 5000 });
      this.wake();
    });
  }

  private wake(): void {
    if (!this.waiting.length) return;
    if (this.pumping) {
      this.wakeAgain = true;
      return;
    }
    this.pumping = true;
    void this.pump()
      .catch((error: unknown) => {
        for (const waiter of this.waiting.splice(0))
          waiter.reject(
            error instanceof Error ? error : new Error('Terminal snapshot admission failed'),
          );
      })
      .finally(() => {
        this.pumping = false;
        if (this.wakeAgain) {
          this.wakeAgain = false;
          this.wake();
        }
      });
  }

  private async pump(): Promise<void> {
    while (this.waiting.length) {
      const reservation = this.tryAcquire();
      if (reservation) {
        this.waiting.shift()!.resolve(reservation);
        continue;
      }
      if (this.budget.usedCount > 0) return;
      const now = performance.now();
      while (this.waiting[0] && this.waiting[0].deadline <= now)
        this.waiting.shift()!.reject(new Error('Terminal snapshot work admission timed out'));
      if (!this.waiting.length) return;
      if (!(await this.budget.waitForAdmission(SCREEN_LIMITS.operationBytes))) {
        for (const waiter of this.waiting.splice(0))
          waiter.reject(
            new Error('Terminal snapshot work capacity exceeded: enclosing capacity unavailable'),
          );
        return;
      }
      // Recheck both local slots and the parent after every yield. The allowance
      // only waits for uncertain ledger admission, not definitive exhaustion.
    }
  }
}
