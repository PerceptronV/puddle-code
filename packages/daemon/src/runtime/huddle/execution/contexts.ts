import type { HuddleRevisionController } from '../control/revisions.js';
import type { HuddleLedger } from '../state/ledger.js';
import type { HuddleGraphRouting } from './graph.js';

type Captured = ReturnType<HuddleRevisionController['forExecution']>;
type ExecutionContext = Captured & { graph: HuddleGraphRouting };

/** One in-memory captured graph per active revision; idle/completed work retains only durable records. */
export class HuddleExecutionContexts {
  private readonly executions = new Map<string, ExecutionContext>();
  private readonly graphs = new Map<string, Pick<ExecutionContext, 'snapshot' | 'graph'>>();
  constructor(
    private readonly ledger: HuddleLedger,
    private readonly revisions: HuddleRevisionController,
  ) {}
  forExecution(id: string): ExecutionContext {
    const existing = this.executions.get(id);
    if (existing) return existing;
    // Each newly started root rechecks retained source before sharing a live immutable graph.
    const captured = this.revisions.forExecution(id);
    let graph = this.graphs.get(captured.snapshot.digest);
    if (!graph) {
      graph = {
        snapshot: captured.snapshot,
        graph: this.ledger.graph(
          captured.snapshot.digest,
          captured.snapshot.definition,
          new Map(Object.entries(captured.snapshot.components)),
        ),
      };
      this.graphs.set(captured.snapshot.digest, graph);
    }
    const context = { activation: captured.activation, ...graph };
    this.executions.set(id, context);
    return context;
  }
  prune(): void {
    const retained = new Set<string>();
    for (const [id, context] of this.executions) {
      if (['pending', 'running'].includes(this.ledger.executions.get(id).state))
        retained.add(context.snapshot.digest);
      else this.executions.delete(id);
    }
    for (const revision of this.graphs.keys())
      if (!retained.has(revision)) this.graphs.delete(revision);
  }
}
