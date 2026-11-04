import type { Socket } from 'node:net';
import { RuntimeBufferBudget, type RuntimeByteAllowance } from '../../runtime/resources/budget.js';
import { runtimeJsonBytes } from '../../runtime/transport/encoding.js';

/** Owner-to-helper writes stay charged until the actual socket completes or closes. */
export class HeadlessWrites {
  private readonly budget: RuntimeBufferBudget;
  private readonly held = new Set<() => void>();
  constructor(
    private readonly socket: Socket,
    allowance?: RuntimeByteAllowance,
  ) {
    this.budget = new RuntimeBufferBudget({ bytes: 8 * 1024 * 1024, count: 256 }, allowance);
    socket.once('close', () => {
      for (const release of this.held) release();
      this.held.clear();
    });
  }

  send(message: Record<string, unknown>): boolean {
    if (this.socket.destroyed) return false;
    let bytes: number;
    try {
      bytes = runtimeJsonBytes(message) + 1;
    } catch {
      return false;
    }
    // The pinned helper accepts at most 2 MiB including its line delimiter.
    if (bytes > 2 * 1024 * 1024) return false;
    const release = this.budget.reserve(4 * bytes + 256);
    if (!release) return false;
    let held = true;
    const complete = () => {
      if (!held) return;
      held = false;
      this.held.delete(complete);
      release();
    };
    this.held.add(complete);
    try {
      this.socket.write(`${JSON.stringify(message)}\n`, complete);
      return true;
    } catch {
      complete();
      return false;
    }
  }
}
