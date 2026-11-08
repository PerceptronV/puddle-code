import type { AgentTurnContext } from '@puddle/shared';
import { RuntimeBufferBudget, type RuntimeByteAllowance } from '../../runtime/resources/budget.js';
import { runtimeJsonRetainedBytes } from '../../runtime/transport/encoding.js';

interface RetiredTurn {
  id: string;
  ref: string;
  hash: string;
  context?: AgentTurnContext;
}

/** Failed admission does not prove that a pasted prompt will never reach its hook. */
export class RetiredInteractiveTurns {
  private readonly entries = new Map<string, { turn: RetiredTurn; release(): void }>();
  private readonly budget: RuntimeBufferBudget;
  incomplete = false;

  constructor(allowance?: RuntimeByteAllowance) {
    this.budget = new RuntimeBufferBudget({ bytes: 128 * 1024, count: 64 }, allowance);
  }

  remember(turn: RetiredTurn): void {
    if (this.entries.has(turn.id)) return;
    const release = this.budget.reserve(runtimeJsonRetainedBytes(turn));
    if (release) this.entries.set(turn.id, { turn: structuredClone(turn), release });
    else this.incomplete = true;
  }

  get(id: string): RetiredTurn | undefined {
    return this.entries.get(id)?.turn;
  }

  close(): void {
    for (const entry of this.entries.values()) entry.release();
    this.entries.clear();
  }
}
