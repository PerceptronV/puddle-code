import type {
  RuntimeByteAllowance,
  RuntimeRetainedAllocation,
  RuntimeRetainedAllowance,
} from '../../../src/runtime/resources/budget.js';

/** Observable admission/refusal fixture; durable host grants have separate ledger tests. */
export class ScreenAllowance implements RuntimeByteAllowance, RuntimeRetainedAllowance {
  used = 0;
  blocked = false;
  refused = 0;
  readonly admitted: number[] = [];
  constructor(public capacity: number) {}

  reserve(bytes: number): (() => void) | null {
    return this.retain(bytes)?.release ?? null;
  }
  retain(bytes: number): RuntimeRetainedAllocation | null {
    if (!this.admit(bytes)) return null;
    let held: number | null = bytes;
    return {
      resize: (next) => {
        if (held === null) return false;
        if (next > held && !this.admit(next - held)) return false;
        if (next < held) this.used -= held - next;
        held = next;
        return true;
      },
      release: () => {
        if (held === null) return;
        this.used -= held;
        held = null;
      },
    };
  }
  private admit(bytes: number): boolean {
    if (this.blocked || this.used + bytes > this.capacity) {
      this.refused++;
      return false;
    }
    this.used += bytes;
    this.admitted.push(bytes);
    return true;
  }
}
