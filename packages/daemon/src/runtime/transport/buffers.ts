import { RUNTIME_LIMITS } from '@puddle/shared';
import { RuntimeBufferBudget, type RuntimeByteAllowance } from '../resources/budget.js';

/** One process's transport domains can spend the same enclosing owner grant. */
export class RuntimeTransportBuffers {
  readonly incoming: RuntimeBufferBudget;
  readonly outgoing: RuntimeBufferBudget;
  readonly encoding: RuntimeBufferBudget;

  constructor(allowance?: RuntimeByteAllowance) {
    this.incoming = new RuntimeBufferBudget({ bytes: 64 * 1024 * 1024, count: 256 }, allowance);
    this.outgoing = new RuntimeBufferBudget({ bytes: 64 * 1024 * 1024, count: 256 }, allowance);
    // Encoding is synchronous; its temporary string/encoding charge ends before
    // slow sockets release their exact outgoing-frame reservations.
    this.encoding = new RuntimeBufferBudget(
      { bytes: 4 * RUNTIME_LIMITS.frameBytes, count: 1 },
      allowance,
    );
  }
}
