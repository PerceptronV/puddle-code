import { HUDDLE_WORKER_LIMITS, type HuddleJson, type HuddleOperationRecord } from '@puddle/shared';
import { RuntimeBufferBudget, type RuntimeByteAllowance } from '../../resources/budget.js';
import { runtimeJsonRetainedBytes } from '../../transport/encoding.js';
import type { HuddleLedger } from '../state/ledger.js';

/** Bounded worker waits shared by operation mailboxes; durable outcomes outlive these promises. */
export class HuddlePendingOperations {
  private readonly budget: RuntimeBufferBudget;
  private readonly pending = new Map<
    string,
    { resolve(value: HuddleJson): void; reject(error: Error): void }
  >();

  constructor(
    private readonly ledger: HuddleLedger,
    private readonly changed: () => void,
    allowance?: RuntimeByteAllowance,
  ) {
    this.budget = new RuntimeBufferBudget(
      { bytes: 16 * 1024 * 1024, count: HUDDLE_WORKER_LIMITS.pending },
      allowance,
    );
  }

  has(id: string) {
    return this.pending.has(id);
  }
  resolve(id: string, value: HuddleJson) {
    this.pending.get(id)?.resolve(value);
  }
  reject(id: string, error: Error) {
    this.pending.get(id)?.reject(error);
  }

  async request(
    input: Pick<HuddleOperationRecord, 'id' | 'invocationId' | 'kind' | 'target' | 'input'>,
    signal: AbortSignal,
  ): Promise<HuddleJson> {
    signal.throwIfAborted();
    if (this.pending.size >= HUDDLE_WORKER_LIMITS.pending)
      throw new Error('Huddle host-operation queue is full');
    if (this.pending.has(input.id)) throw new Error('Huddle operation is already waiting');
    const release = this.budget.reserve(runtimeJsonRetainedBytes(input) + 16_384);
    if (!release) throw new Error('Host memory admission is unavailable for a huddle operation');
    let cancelled = () => {};
    try {
      const intent = this.ledger.operations.prepare(input);
      if (intent.duplicate)
        throw new Error('Observe the retained operation instead of repeating a worker request');
      return await new Promise<HuddleJson>((resolve, reject) => {
        this.pending.set(input.id, { resolve, reject });
        cancelled = () => {
          try {
            const record = this.ledger.operations.get(input.id);
            if (record.state === 'prepared') this.ledger.operations.cancelUnsent(record.id);
            else if (record.state === 'dispatched')
              this.ledger.operations.unknown(
                record.id,
                'Node stopped while awaiting host operation',
              );
            this.changed();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error('Huddle operation cancelled'),
          );
        };
        signal.addEventListener('abort', cancelled, { once: true });
        // Admission callbacks can synchronously revoke the caller before the listener exists.
        if (signal.aborted) cancelled();
        else this.changed();
      });
    } finally {
      signal.removeEventListener('abort', cancelled);
      this.pending.delete(input.id);
      release();
    }
  }
}
