import { randomUUID } from 'node:crypto';
import {
  HUDDLE_WORKER_LIMITS,
  huddleWorkerRequestSchema,
  type HuddleWorkerAction,
  type HuddleWorkerInput,
  type HuddleWorkerRequest,
} from '@puddle/shared';
import { createPuddlangClient, type PuddlangClient } from '../../../puddlang/client.js';

let client: PuddlangClient | undefined;
export function workerPuddlang(): PuddlangClient {
  if (!client) throw new Error('No huddle invocation is active');
  return client;
}

/** One worker serves one invocation. No request is retried after disconnect. */
export class HuddleWorkerCalls {
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private count = 0;
  private continuous = false;
  private windowAt = performance.now();
  private windowCount = 0;
  private closed = false;
  readonly api: PuddlangClient;
  constructor(private readonly send: (message: HuddleWorkerRequest) => void) {
    this.api = createPuddlangClient((operation) => this.call({ kind: 'operation', operation }));
    client = this.api;
  }
  get pendingCount() {
    return this.pending.size;
  }
  subscribe() {
    this.continuous = true;
  }
  call(action: HuddleWorkerAction): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.closed) throw new Error('Huddle worker disconnected');
      if (performance.now() - this.windowAt >= 1000) {
        this.windowAt = performance.now();
        this.windowCount = 0;
      }
      const sequence = ++this.count;
      if (
        this.pending.size >= HUDDLE_WORKER_LIMITS.pending ||
        !Number.isSafeInteger(sequence) ||
        (this.continuous
          ? ++this.windowCount > HUDDLE_WORKER_LIMITS.subscriptionRequestsPerSecond
          : sequence > HUDDLE_WORKER_LIMITS.requests)
      )
        throw new Error('Huddle worker request limit exceeded');
      const message = huddleWorkerRequestSchema.parse({
        type: 'request',
        id: randomUUID(),
        ...(this.continuous ? { sequence } : {}),
        action,
      });
      this.pending.set(message.id, { resolve, reject });
      try {
        this.send(message);
      } catch (error) {
        this.pending.delete(message.id);
        reject(error);
      }
    });
  }
  receive(message: Extract<HuddleWorkerInput, { type: 'reply' | 'reject' }>): void {
    const request = this.pending.get(message.id);
    if (!request) throw new Error('Unexpected huddle worker reply');
    this.pending.delete(message.id);
    if (message.type === 'reject') request.reject(new Error(message.error));
    else request.resolve(message.value);
  }
  close(reason: Error): void {
    this.closed = true;
    for (const request of this.pending.values()) request.reject(reason);
    this.pending.clear();
  }
}
