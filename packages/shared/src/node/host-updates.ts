import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import {
  hostUpdateCommandSchema,
  type HostUpdateCommand,
  type HostUpdateReply,
  type hostUpdateControlResponseSchema,
} from '../api/connection/host-updates.js';
import type { z } from 'zod';

type Response = z.infer<typeof hostUpdateControlResponseSchema>;

/** One control generation's correlated calls. Loss rejects them; nothing is replayed. */
export class HostUpdateRequests {
  private readonly pending = new Map<
    string,
    {
      resolve(result: HostUpdateReply): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly expired = new Set<string>();
  private issued = 0;
  private closed = false;
  constructor(private readonly channel: Duplex) {}

  request(input: HostUpdateCommand): Promise<HostUpdateReply> {
    const command = hostUpdateCommandSchema.parse(input);
    if (this.closed || this.channel.destroyed)
      return Promise.reject(new Error('Host control is unavailable'));
    if (this.pending.size >= 4 || this.issued >= 1024)
      return Promise.reject(new Error('Host update control limit reached'));
    const request_id = randomUUID();
    this.issued++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        this.expired.add(request_id);
        reject(new Error('Host update response timed out; inspect the operation before retrying'));
      }, 120_000);
      timer.unref();
      this.pending.set(request_id, { resolve, reject, timer });
      try {
        this.channel.write(JSON.stringify({ t: 'host-update', request_id, command }) + '\n');
      } catch {
        // A transport can throw after accepting bytes; abandon this generation.
        this.close();
        this.channel.destroy();
      }
    });
  }

  receive(message: Response): boolean {
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
