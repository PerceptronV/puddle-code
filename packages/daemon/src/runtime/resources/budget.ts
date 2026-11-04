export interface RuntimeBufferCapacity {
  bytes: number;
  count: number;
}

/** Charged buffer capacity, not a guarantee about total process memory or GC timing. */
export class RuntimeBufferBudget {
  private bytes = 0;
  private count = 0;
  private readonly capacity: RuntimeBufferCapacity;

  constructor(capacity: RuntimeBufferCapacity) {
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
    if (
      !this.valid(bytes) ||
      !this.valid(count) ||
      bytes > this.capacity.bytes - this.bytes ||
      count > this.capacity.count - this.count
    )
      return null;
    this.bytes += bytes;
    this.count += count;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.bytes -= bytes;
      this.count -= count;
    };
  }

  private valid(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
  }
}
