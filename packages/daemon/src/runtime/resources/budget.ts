export interface RuntimeBufferCapacity {
  bytes: number;
  count: number;
}

/** An enclosing allowance may be shared by otherwise independent buffer domains. */
export interface RuntimeByteAllowance {
  reserve(bytes: number): (() => void) | null;
  /** Only unresolved durable admission may wait; definitive exhaustion returns false. */
  waitForAdmission?(): Promise<boolean>;
}

/** A retained domain can shrink without releasing capacity still backing live state. */
export interface RuntimeRetainedAllocation {
  resize(bytes: number): boolean;
  release(): void;
}

export interface RuntimeRetainedAllowance {
  retain(bytes: number): RuntimeRetainedAllocation | null;
}

/** Charged buffer capacity, not a guarantee about total process memory or GC timing. */
export class RuntimeBufferBudget {
  private bytes = 0;
  private count = 0;
  private readonly capacity: RuntimeBufferCapacity;

  constructor(
    capacity: RuntimeBufferCapacity,
    private readonly allowance?: RuntimeByteAllowance,
  ) {
    if (!this.valid(capacity.bytes) || !this.valid(capacity.count))
      throw new Error('Invalid runtime buffer capacity');
    this.capacity = { ...capacity };
  }

  get usedBytes(): number {
    return this.bytes;
  }

  get usedCount(): number {
    return this.count;
  }

  reserve(bytes: number, count = 1): (() => void) | null {
    if (!this.fits(bytes, count)) return null;
    const releaseAllowance = this.allowance?.reserve(bytes);
    if (this.allowance && !releaseAllowance) return null;
    this.bytes += bytes;
    this.count += count;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.bytes -= bytes;
      this.count -= count;
      releaseAllowance?.();
    };
  }

  waitForAdmission(bytes: number, count = 1): Promise<boolean> {
    if (!this.fits(bytes, count)) return Promise.resolve(false);
    return this.allowance?.waitForAdmission?.() ?? Promise.resolve(false);
  }

  private fits(bytes: number, count: number): boolean {
    return (
      this.valid(bytes) &&
      this.valid(count) &&
      bytes <= this.capacity.bytes - this.bytes &&
      count <= this.capacity.count - this.count
    );
  }

  private valid(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
  }
}
