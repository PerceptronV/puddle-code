import type { RuntimeBufferBudget } from '../../runtime/resources/budget.js';
import { screenActionBytes } from './limits.js';
import type { ScreenParserQueue } from './queue.js';

type Produce = (accept: (data: string) => void) => string | null;
interface Reader {
  accept?: (data: string) => void;
  resolve(data: string | null): void;
  reject(error: unknown): void;
  release(): void;
  failed: boolean;
}
interface Batch {
  boundary: number;
  readers: Reader[];
}

/**
 * Share only a not-yet-executed capture at the same ordered input boundary.
 * Every reader retains its metadata admission; all ownership hand-offs happen
 * inside the producer's existing work allowance. No ANSI is cached afterwards.
 */
export class ScreenCaptureBatch {
  private pending: Batch | undefined;

  constructor(
    private readonly queue: ScreenParserQueue,
    private readonly metadata: RuntimeBufferBudget,
  ) {}

  capture(produce: Produce, accept?: Reader['accept']): Promise<string | null> {
    const existing = this.pending;
    if (existing && existing.boundary === this.queue.inputRevision) {
      const release = this.metadata.reserve(screenActionBytes());
      if (!release) return Promise.reject(new Error('Terminal snapshot action capacity exceeded'));
      return new Promise((resolve, reject) => {
        existing.readers.push({ accept, resolve, reject, release, failed: false });
      });
    }

    const batch: Batch = { boundary: this.queue.inputRevision, readers: [] };
    this.pending = batch;
    return new Promise((resolve, reject) => {
      // The queue action already admits the first reader's metadata.
      batch.readers.push({ accept, resolve, reject, release: () => {}, failed: false });
      void this.queue
        .capture(screenActionBytes(), () => {
          // Seal before serialising/accepting. A re-entrant request must queue its
          // own boundary, never grow this batch while consumers are being called.
          if (this.pending === batch) this.pending = undefined;
          try {
            const data = produce((data) => {
              for (const reader of batch.readers) {
                try {
                  reader.accept?.(data);
                } catch (error) {
                  reader.failed = true;
                  reader.reject(error);
                }
              }
            });
            for (const reader of batch.readers) if (!reader.failed) reader.resolve(data);
          } finally {
            for (const reader of batch.readers) reader.release();
          }
        })
        .catch((error: unknown) => {
          if (this.pending === batch) this.pending = undefined;
          for (const reader of batch.readers) {
            reader.reject(error);
            // Reservations release idempotently, including queue cancellation.
            reader.release();
          }
        });
    });
  }
}
