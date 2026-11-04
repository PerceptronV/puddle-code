import type {
  RuntimeByteAllowance,
  RuntimeRetainedAllocation,
  RuntimeRetainedAllowance,
} from '../../../runtime/resources/budget.js';

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

const GROWTH_ROWS = 64;
const HISTORY_RETRY_MS = 1000;

/** One store, including every terminal: no per-terminal copy of the allowance. */
export class ScreenRetainedBudget {
  private readonly screens = new Set<ScreenRetainedLease>();
  private variables = 0;
  private burst = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly historyRetryAt = new WeakMap<ScreenRetainedLease, number>();

  readonly limits: Readonly<ScreenRetainedLimits>;
  constructor(
    limits: Readonly<ScreenRetainedLimits> = SCREEN_RETAINED_LIMITS,
    readonly allowance?: RuntimeByteAllowance & RuntimeRetainedAllowance,
    private readonly now: () => number = () => performance.now(),
  ) {
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
    // Viewports plus bounded admitted history chunks, not maximum future history
    // or a measurement of resident backing/GC timing.
    return [...this.screens].reduce((total, lease) => total + lease.geometryBytes, 0);
  }
  get burstBytes(): number {
    return this.burst;
  }

  admit(cols: number, rows: number): ScreenRetainedLease {
    if ((this.screens.size + 1) * this.limits.screenControlBytes > this.limits.controlBytes)
      throw new Error('Canonical terminal control capacity exhausted');
    const lease = new ScreenRetainedLease(this, { cols, rows, scrollback: 0 });
    try {
      this.rebalance(lease, cols, rows);
      this.screens.add(lease);
      return lease;
    } catch (error) {
      // No emulator exists yet. Other leases keep any positively trimmed state.
      lease.dispose();
      throw error;
    }
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
    const plans = dimensions.map((entry) => ({
      ...entry,
      // New/idle screens reserve no speculative scrollback. Existing history
      // may shrink for another viewport, but grows only on actual scrolling.
      scrollback: Math.min(entry.lease.scrollback, this.limits.scrollback),
    }));
    let excess = plans.reduce(
      (total, plan) => total + this.geometry(plan.cols, plan.rows, plan.scrollback),
      -this.limits.geometryBytes,
    );
    // Reclaim only what the new viewport/peak width actually needs. Largest
    // history first, with stable creation-order ties, avoids idle peers wasting
    // capacity or trimming healthy history just to create equal future shares.
    const donors = [...plans].sort(
      (a, b) => b.scrollback * this.line(b.cols) - a.scrollback * this.line(a.cols),
    );
    for (const plan of donors) {
      if (excess <= 0) break;
      const rows = Math.min(plan.scrollback, Math.ceil(excess / this.line(plan.cols)));
      plan.scrollback -= rows;
      excess -= rows * this.line(plan.cols);
    }
    // Shrink before growing. A failed trim leaves the previous allocation charged.
    for (const plan of plans)
      if (plan.scrollback < plan.lease.scrollback) plan.lease.trim(plan.scrollback);
    for (const plan of plans) plan.lease.setGeometry(plan.cols, plan.rows, plan.scrollback);
  }

  /** Admit a small block before xterm raises backing capacity or clones a row. */
  grow(lease: ScreenRetainedLease): boolean {
    if (!this.screens.has(lease)) return false;
    if (this.now() < (this.historyRetryAt.get(lease) ?? 0)) return false;
    const available = Math.floor(
      (this.limits.geometryBytes - this.geometryBytes) / this.line(lease.cols),
    );
    const rows = Math.min(GROWTH_ROWS, this.limits.scrollback - lease.scrollback, available);
    if (rows <= 0) return false;
    if (!lease.trySetGeometry(lease.cols, lease.rows, lease.scrollback + rows)) {
      // A full shared grant must not turn every subsequent newline into ledger
      // IO. Output continues with normal history rollover until a later retry.
      this.historyRetryAt.set(lease, this.now() + HISTORY_RETRY_MS);
      return false;
    }
    this.historyRetryAt.delete(lease);
    return true;
  }

  geometry(cols: number, rows: number, scrollback: number): number {
    // One cached blank row, normal scrollback/viewport and alternate viewport.
    return this.line(cols) * (scrollback + 2 * rows + 1);
  }
  line(cols: number): number {
    return cols * this.limits.cellBytes + this.limits.lineBytes;
  }

  changeVariables(previous: number, next: number, admit: () => boolean): boolean {
    if (
      !Number.isSafeInteger(next) ||
      next < 0 ||
      next - previous > this.limits.variableBytes - this.variables
    )
      return false;
    if (!admit()) return false;
    this.variables += next - previous;
    return true;
  }

  /** Waiters belong to already charged parser actions, not unbounded input closures. */
  async acquireBurst(bytes: number): Promise<() => void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limits.burstBytes)
      throw new Error('Canonical terminal operation exceeds burst capacity');
    while (bytes > this.limits.burstBytes - this.burst)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    // Global refusal cannot be woken by an unrelated domain's release. Only
    // local contention waits; a refused enclosing grant is an explicit failure.
    const releaseAllowance = this.allowance?.reserve(bytes);
    if (this.allowance && !releaseAllowance)
      throw new Error('Canonical terminal host burst capacity exhausted');
    this.burst += bytes;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.burst -= bytes;
      releaseAllowance?.();
      for (const wake of this.waiting.splice(0)) wake();
    };
  }

  remove(lease: ScreenRetainedLease): void {
    this.screens.delete(lease);
    this.historyRetryAt.delete(lease);
  }
}

/** Keeps old width/height charged after shrink: xterm can retain larger array backing. */
export class ScreenRetainedLease {
  private variables = 0;
  private closed = false;
  private trimScreen: ((scrollback: number) => void) | undefined;
  private allocation: RuntimeRetainedAllocation | null = null;
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
    if (!Number.isSafeInteger(scrollback) || scrollback < 0 || scrollback > this.scrollback)
      throw new Error('History trimming cannot increase retained capacity');
    this.trimScreen?.(scrollback);
    if (!this.retain(this.owner.geometry(this.cols, this.rows, scrollback), this.variables))
      throw new Error('Canonical terminal retained capacity return could not be verified');
    this.dimensions.scrollback = scrollback;
  }
  setGeometry(cols: number, rows: number, scrollback: number): void {
    if (!this.trySetGeometry(cols, rows, scrollback))
      throw new Error('Canonical terminal host geometry capacity exhausted');
  }
  trySetGeometry(cols: number, rows: number, scrollback: number): boolean {
    if (cols < this.cols || rows < this.rows || scrollback < this.scrollback)
      throw new Error('Geometry capacity requires a proven trim before shrinking');
    if (!this.retain(this.owner.geometry(cols, rows, scrollback), this.variables)) return false;
    // Growth is charged before the callback can allocate backing. An unexpected
    // callback failure keeps that conservative charge until owner disposal.
    this.dimensions = { cols, rows, scrollback };
    this.trimScreen?.(scrollback);
    return true;
  }
  private retain(geometry: number, variables: number): boolean {
    if (!this.owner.allowance) return true;
    const bytes = geometry + variables + this.owner.limits.screenControlBytes;
    if (this.allocation) return this.allocation.resize(bytes);
    this.allocation = this.owner.allowance.retain(bytes);
    return this.allocation !== null;
  }
  private changeVariables(next: number): boolean {
    return this.owner.changeVariables(this.variables, next, () =>
      this.retain(this.geometryBytes, next),
    );
  }
  charge(bytes: number, inspect: () => number): boolean {
    if (this.closed || !Number.isSafeInteger(bytes) || bytes < 0) return false;
    let next = this.variables + bytes;
    if (!this.changeVariables(next)) {
      const retained = inspect();
      if (!this.changeVariables(retained)) return false;
      this.variables = retained;
      next = retained + bytes;
      if (!this.changeVariables(next)) return false;
    }
    this.variables = next;
    return true;
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.trimScreen = undefined;
    this.owner.changeVariables(this.variables, 0, () => true);
    this.allocation?.release();
    this.allocation = null;
    this.owner.remove(this);
  }
}
