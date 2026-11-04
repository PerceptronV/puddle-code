import type {
  RuntimeByteAllowance,
  RuntimeRetainedAllocation,
  RuntimeRetainedAllowance,
} from '../budget.js';
import type { HostMemoryGrant, HostMemoryIdentity, HostMemoryLedger } from './ledger.js';

/**
 * One live owner spends a durable grant locally. Its existing ownership claim
 * must exclude another cache for this identity and grant retirement throughout
 * this object's lifetime. This counts managed capacity, not process RSS.
 */
export class RuntimeHostAllowance implements RuntimeByteAllowance, RuntimeRetainedAllowance {
  private readonly identity: HostMemoryIdentity;
  private grant: HostMemoryGrant;
  private spendable: number;
  private used = 0;
  private pending: HostMemoryGrant | null = null;
  private invalid = false;
  private admissionWait: Promise<boolean> | null = null;

  constructor(
    private readonly ledger: Pick<HostMemoryLedger, 'readGrant' | 'compareGrant'>,
    identity: HostMemoryIdentity,
    private readonly chunkBytes: number,
    private readonly spareBytes: number,
    private readonly onReturn?: () => void,
  ) {
    if (!validBytes(chunkBytes) || chunkBytes === 0 || !validBytes(spareBytes))
      throw new Error('Invalid runtime host allowance policy');
    this.identity = { ...identity };
    this.grant = ledger.readGrant(this.identity) ?? { revision: 0, bytes: 0 };
    this.spendable = this.grant.bytes;
  }

  get usedBytes(): number {
    return this.used;
  }

  /** Includes only capacity safe to spend after a possibly uncertain return. */
  get availableBytes(): number {
    return Math.max(0, this.spendable - this.used);
  }

  reserve(bytes: number): (() => void) | null {
    return this.retain(bytes)?.release ?? null;
  }

  /** Coalesced yielding only for an unresolved CAS, never a second grant path. */
  waitForAdmission(): Promise<boolean> {
    if (this.invalid || !this.pending) return Promise.resolve(false);
    this.admissionWait ??= new Promise<boolean>((resolve) => {
      setTimeout(() => {
        this.admissionWait = null;
        resolve(!this.invalid);
      }, 25);
    });
    return this.admissionWait;
  }

  retain(bytes: number): RuntimeRetainedAllocation | null {
    if (!this.admit(bytes)) return null;
    let held: number | null = bytes;
    return {
      resize: (next) => {
        if (held === null || !validBytes(next)) return false;
        if (next > held && !this.admit(next - held)) return false;
        if (next < held) {
          this.used -= held - next;
          this.onReturn?.();
        }
        held = next;
        return true;
      },
      release: () => {
        if (held === null) return;
        this.used -= held;
        if (held > 0) this.onReturn?.();
        held = null;
      },
    };
  }

  /** Existing releases remain valid; no new allocation may use a stopped owner. */
  close(): void {
    this.invalid = true;
  }

  private admit(bytes: number): boolean {
    if (!validBytes(bytes) || this.invalid || !validBytes(this.used + bytes)) return false;
    const needed = this.used + bytes;
    if (needed > this.spendable) {
      if (!this.observe()) return false;
      if (needed > this.spendable) {
        const rounded = Math.ceil(needed / this.chunkBytes) * this.chunkBytes;
        const desired = validBytes(rounded) ? rounded : needed;
        if (!this.change(desired)) {
          // Rounded spare capacity must not exclude an otherwise affordable
          // operation. Retry only a confirmed refusal, never an uncertain CAS.
          if (this.pending || desired === needed || !this.change(needed)) return false;
        }
      }
    }
    this.used = needed;
    return true;
  }

  /** Called by coalesced idle maintenance; release paths do no filesystem I/O. */
  trim(): boolean {
    if (this.invalid || !this.observe()) return false;
    const target = Math.min(this.spendable, this.used + this.spareBytes);
    return target === this.spendable || this.change(target);
  }

  private observe(): boolean {
    if (!this.pending) return true;
    try {
      const actual = this.ledger.readGrant(this.identity) ?? { revision: 0, bytes: 0 };
      if (!sameGrant(actual, this.grant) && !sameGrant(actual, this.pending)) {
        // A second writer or unexpected retirement violates the owner claim.
        // Existing allocations cannot be undone; never admit more against it.
        this.invalid = true;
        this.spendable = this.used;
        return false;
      }
      this.grant = actual;
      this.spendable = actual.bytes;
      this.pending = null;
      return true;
    } catch {
      return false;
    }
  }

  private change(bytes: number): boolean {
    if (this.invalid || bytes < this.used || !validBytes(bytes) || this.pending) return false;
    const next = { revision: this.grant.revision + 1, bytes };
    // Remove returned capacity from local use BEFORE it may become available
    // to another owner. A lost commit reply cannot make both owners spend it.
    this.spendable = Math.min(this.spendable, bytes);
    try {
      const actual = this.ledger.compareGrant(this.identity, this.grant.revision, bytes);
      if (!actual) {
        // Null is a definite non-mutation, but may indicate a revision conflict.
        // Observe the current grant before retrying a different requested size.
        this.pending = next;
        this.observe();
        return false;
      }
      if (!sameGrant(actual, next)) {
        this.invalid = true;
        return false;
      }
      this.grant = actual;
      this.spendable = actual.bytes;
      return true;
    } catch {
      this.pending = next;
      return false;
    }
  }
}

function sameGrant(left: HostMemoryGrant, right: HostMemoryGrant): boolean {
  return left.revision === right.revision && left.bytes === right.bytes;
}

function validBytes(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes >= 0;
}
