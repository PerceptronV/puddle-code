/** Charged retained capacity; these allowances are not measurements of JavaScript RSS. */
export interface ScreenRetainedLimits {
  geometryBytes: number;
  variableBytes: number;
  controlBytes: number;
  burstBytes: number;
  cellBytes: number;
  lineBytes: number;
  screenControlBytes: number;
  scrollback: number;
  combinedUnits: number;
  sequenceUnits: number;
  titleUnits: number;
  linkUnits: number;
  links: number;
  markers: number;
  writeUnits: number;
}

export const SCREEN_RETAINED_LIMITS: Readonly<ScreenRetainedLimits> = Object.freeze({
  geometryBytes: 96 * 1024 * 1024,
  variableBytes: 24 * 1024 * 1024,
  controlBytes: 8 * 1024 * 1024,
  burstBytes: 16 * 1024 * 1024,
  // Includes the three Uint32 cells and conservative per-cell/dictionary metadata.
  cellBytes: 64,
  lineBytes: 256,
  // Bounded partial sequence, title/icon stacks, decoder and parser working state.
  screenControlBytes: 256 * 1024,
  scrollback: 20_000,
  combinedUnits: 8 * 1024,
  sequenceUnits: 32 * 1024,
  titleUnits: 2 * 1024,
  linkUnits: 8 * 1024,
  links: 1024,
  markers: 4096,
  // Keeps the pinned parser's retained UTF32 decoding buffer at its initial size.
  writeUnits: 4096,
});

interface Geometry {
  cols: number;
  rows: number;
  scrollback: number;
}

/** One store, including every terminal: no per-terminal copy of the allowance. */
export class ScreenRetainedBudget {
  private readonly screens = new Set<ScreenRetainedLease>();
  private variables = 0;
  private burst = 0;
  private readonly waiting: Array<() => void> = [];

  readonly limits: Readonly<ScreenRetainedLimits>;
  constructor(limits: Readonly<ScreenRetainedLimits> = SCREEN_RETAINED_LIMITS) {
    if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1))
      throw new Error('Invalid retained terminal capacity');
    if (limits.writeUnits < 2 || limits.writeUnits > 4096)
      throw new Error('Invalid terminal parse chunk size');
    this.limits = Object.freeze({ ...limits });
  }

  get variableBytes(): number {
    return this.variables;
  }
  get geometryBytes(): number {
    // Reserved future capacity, including scrollback: not measured live backing.
    return [...this.screens].reduce((total, lease) => total + lease.geometryBytes, 0);
  }
  get burstBytes(): number {
    return this.burst;
  }

  admit(cols: number, rows: number): ScreenRetainedLease {
    if ((this.screens.size + 1) * this.limits.screenControlBytes > this.limits.controlBytes)
      throw new Error('Canonical terminal control capacity exhausted');
    const lease = new ScreenRetainedLease(this, { cols, rows, scrollback: 0 });
    this.rebalance(lease, cols, rows);
    this.screens.add(lease);
    return lease;
  }

  /** Rebalance only old scrollback; existing viewports and backing widths stay charged. */
  rebalance(target: ScreenRetainedLease, cols: number, rows: number): void {
    if (![cols, rows].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 1000))
      throw new Error('Invalid canonical terminal geometry');
    cols = Math.max(2, cols);
    const entries = [...this.screens];
    if (!this.screens.has(target)) entries.push(target);
    const dimensions = entries.map((lease) => ({
      lease,
      cols: lease === target ? Math.max(cols, lease.cols) : lease.cols,
      rows: lease === target ? Math.max(rows, lease.rows) : lease.rows,
    }));
    const minimum = dimensions.reduce(
      (total, entry) => total + this.geometry(entry.cols, entry.rows, 0),
      0,
    );
    if (minimum > this.limits.geometryBytes)
      throw new Error('Canonical terminal viewports exceed retained capacity');
    const share = Math.floor((this.limits.geometryBytes - minimum) / entries.length);
    const plans = dimensions.map((entry) => ({
      ...entry,
      scrollback: Math.min(this.limits.scrollback, Math.floor(share / this.line(entry.cols))),
    }));
    // Shrink before growing. A failed trim leaves the previous allocation charged.
    for (const plan of plans)
      if (plan.scrollback < plan.lease.scrollback) plan.lease.trim(plan.scrollback);
    for (const plan of plans) plan.lease.setGeometry(plan.cols, plan.rows, plan.scrollback);
  }

  geometry(cols: number, rows: number, scrollback: number): number {
    // One cached blank row, normal scrollback/viewport and alternate viewport.
    return this.line(cols) * (scrollback + 2 * rows + 1);
  }
  line(cols: number): number {
    return cols * this.limits.cellBytes + this.limits.lineBytes;
  }

  changeVariables(previous: number, next: number): boolean {
    if (
      !Number.isSafeInteger(next) ||
      next < 0 ||
      next - previous > this.limits.variableBytes - this.variables
    )
      return false;
    this.variables += next - previous;
    return true;
  }

  /** Waiters belong to already charged parser actions, not unbounded input closures. */
  async acquireBurst(bytes: number): Promise<() => void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limits.burstBytes)
      throw new Error('Canonical terminal operation exceeds burst capacity');
    while (bytes > this.limits.burstBytes - this.burst)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.burst += bytes;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.burst -= bytes;
      for (const wake of this.waiting.splice(0)) wake();
    };
  }

  remove(lease: ScreenRetainedLease): void {
    this.screens.delete(lease);
  }
}

/** Keeps old width/height charged after shrink: xterm can retain larger array backing. */
export class ScreenRetainedLease {
  private variables = 0;
  private closed = false;
  private trimScreen: ((scrollback: number) => void) | undefined;
  constructor(
    readonly owner: ScreenRetainedBudget,
    private dimensions: Geometry,
  ) {}
  get cols(): number {
    return this.dimensions.cols;
  }
  get rows(): number {
    return this.dimensions.rows;
  }
  get scrollback(): number {
    return this.dimensions.scrollback;
  }
  get geometryBytes(): number {
    return this.owner.geometry(this.cols, this.rows, this.scrollback);
  }
  attach(trim: (scrollback: number) => void): void {
    this.trimScreen = trim;
  }
  trim(scrollback: number): void {
    this.trimScreen?.(scrollback);
    this.dimensions.scrollback = scrollback;
  }
  setGeometry(cols: number, rows: number, scrollback: number): void {
    this.trimScreen?.(scrollback);
    this.dimensions = { cols, rows, scrollback };
  }
  charge(bytes: number, inspect: () => number): boolean {
    if (this.closed || !Number.isSafeInteger(bytes) || bytes < 0) return false;
    let next = this.variables + bytes;
    if (!this.owner.changeVariables(this.variables, next)) {
      const retained = inspect();
      if (!this.owner.changeVariables(this.variables, retained)) return false;
      this.variables = retained;
      next = retained + bytes;
      if (!this.owner.changeVariables(this.variables, next)) return false;
    }
    this.variables = next;
    return true;
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.trimScreen = undefined;
    this.owner.changeVariables(this.variables, 0);
    this.owner.remove(this);
  }
}
