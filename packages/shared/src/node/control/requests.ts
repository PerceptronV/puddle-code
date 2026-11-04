import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { CONTROL_MAX_BYTES } from '../../api/connection/connection-auth.js';

export const HOST_CONTROL_REQUEST_LIMITS = {
  pending: 4,
  issued: 1024,
  timeoutMs: 120_000,
} as const;

/** One control generation's correlated calls. Loss rejects them; nothing is replayed. */
export class HostControlRequests<Command, Reply> {
  private readonly pending = new Map<
    string,
    {
      resolve(result: Reply): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly expired = new Set<string>();
  private issued = 0;
  private closed = false;
  constructor(
    private readonly channel: Duplex,
    private readonly options: {
      type: 'host-update' | 'host-maintenance';
      parse(value: unknown): Command;
      timeoutMs?: number;
    },
  ) {}

  request(input: Command): Promise<Reply> {
    const command = this.options.parse(input);
    if (this.closed || this.channel.destroyed)
      return Promise.reject(new Error('Host control is unavailable'));
    if (
      this.pending.size >= HOST_CONTROL_REQUEST_LIMITS.pending ||
      this.issued >= HOST_CONTROL_REQUEST_LIMITS.issued
    )
      return Promise.reject(new Error('Host update control limit reached'));
    const request_id = randomUUID();
    const frame = JSON.stringify({ t: this.options.type, request_id, command }) + '\n';
    if (Buffer.byteLength(frame) > CONTROL_MAX_BYTES)
      return Promise.reject(new Error('Host control request exceeds its limit'));
    this.issued++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        this.expired.add(request_id);
        reject(new Error('Host update response timed out; inspect the operation before retrying'));
      }, this.options.timeoutMs ?? HOST_CONTROL_REQUEST_LIMITS.timeoutMs);
      timer.unref();
      this.pending.set(request_id, { resolve, reject, timer });
      try {
        this.channel.write(frame);
      } catch {
        // A transport can throw after accepting bytes; abandon this generation.
        this.close();
        this.channel.destroy();
      }
    });
  }

  receive(message: { request_id: string; result: Reply }): boolean {
    const pending = this.pending.get(message.request_id);
    if (!pending) return this.expired.delete(message.request_id);
    this.pending.delete(message.request_id);
    clearTimeout(pending.timer);
    pending.resolve(message.result);
    return true;
  }

  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Host control was lost; inspect the operation before retrying'));
    }
    this.pending.clear();
    this.expired.clear();
  }
}
