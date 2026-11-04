import { RUNTIME_LIMITS } from '@puddle/shared';
import { RuntimeBufferBudget } from '../../resources/budget.js';

// Conservative charged capacities for controller-owned buffering, not total RSS limits.
// Snapshot admission includes checkpoint read/parse copies and retained response text.
// Eight simultaneous attaches are admitted; excess viewers reconnect independently.
export const TERMINAL_SNAPSHOT_BYTES = 6 * RUNTIME_LIMITS.frameBytes + 256;

export class RuntimeTerminalBuffers {
  readonly snapshots = new RuntimeBufferBudget({ bytes: 8 * TERMINAL_SNAPSHOT_BYTES, count: 8 });
  readonly output = new RuntimeBufferBudget({ bytes: 32 * 1024 * 1024, count: 16_384 });
  readonly input = new RuntimeBufferBudget({ bytes: 64 * 1024 * 1024, count: 256 });
}

/** Retained JS text plus UTF-8 and an eventual joined JS output copy. */
export const terminalOutputBytes = (data: string): number =>
  256 + 4 * data.length + Buffer.byteLength(data);

/** Original JS text, UTF-8 paste buffer and the current decoded request chunk. */
export const terminalInputBytes = (data: string): number =>
  256 + 2 * data.length + 2 * Buffer.byteLength(data);
