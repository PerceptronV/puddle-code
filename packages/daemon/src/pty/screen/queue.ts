import type { RuntimeBufferBudget } from '../../runtime/resources/budget.js';

/** One ordered parser queue; bytes/actions stay charged until their closures settle. */
export class ScreenParserQueue {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(
    private readonly budget: RuntimeBufferBudget,
    private readonly failed: (error: unknown) => void,
    private readonly captures: RuntimeBufferBudget = budget,
  ) {}

  get settled(): Promise<void> {
    return this.tail;
  }

  enqueue(
    bytes: number,
    operation: () => Promise<void>,
    options: { cancelled?: () => void; critical?: boolean } = {},
  ): boolean {
    if (this.closed) return false;
    const release = (options.critical === false ? this.captures : this.budget).reserve(bytes);
    if (!release) {
      if (options.critical !== false) {
        this.closed = true;
        this.failed(new Error('Canonical terminal input exceeded its buffer capacity'));
      }
      return false;
    }
    return this.enqueueAdmitted(release, operation, options);
  }

  /** Transfer an initial action's reservation obtained before constructing its screen. */
  enqueueAdmitted(
    release: () => void,
    operation: () => Promise<void>,
    options: { cancelled?: () => void } = {},
  ): boolean {
    if (this.closed) {
      release();
      options.cancelled?.();
      return false;
    }
    this.tail = this.tail
      .then(async () => {
        if (!this.closed) await operation();
        else options.cancelled?.();
      })
      .catch((error: unknown) => {
        this.closed = true;
        this.failed(error);
      })
      .finally(release);
    return true;
  }

  /** Enqueue before yielding; later PTY bytes must stay after this capture boundary. */
  capture<T>(bytes: number, operation: () => T): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancelled = () =>
        reject(
          new Error(
            'Canonical terminal screen is unavailable or snapshot action capacity exceeded',
          ),
        );
      if (
        !this.enqueue(
          bytes,
          async () => {
            try {
              resolve(operation());
            } catch (error) {
              reject(error);
            }
          },
          { cancelled, critical: false },
        )
      )
        cancelled();
    });
  }

  /** In-flight work retains its reservation; queued closures settle without execution. */
  close(): void {
    this.closed = true;
  }
}
