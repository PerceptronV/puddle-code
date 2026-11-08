import {
  huddleEmissionRecordSchema,
  huddleExecutionRecordSchema,
  huddleInvocationRecordSchema,
  huddleOperationRecordSchema,
  huddleJoinRecordSchema,
  type HuddleDefinition,
  type HuddleComponent,
  type HuddleLedgerIdentity,
} from '@puddle/shared';
import { HuddleStateDatabase, type HuddleCollection, type LedgerRow } from './database.js';
import { HuddleExecutions } from './executions.js';
import { HuddleInvocations } from './invocations.js';
import { HuddleOperations } from './operations.js';
import { HuddleGraphRouting } from '../execution/graph.js';
import { HuddleIntervals } from './intervals.js';
import { HuddleSchedules } from './schedules.js';
import { HuddleFiletrees } from './filetrees.js';
import { HuddleActivations } from './activation.js';

/** Owner-local durable execution authority; application SQLite remains daemon-owned. */
export class HuddleLedger {
  readonly executions: HuddleExecutions;
  readonly invocations: HuddleInvocations;
  readonly operations: HuddleOperations;
  readonly activations: HuddleActivations;
  readonly intervals: HuddleIntervals;
  readonly schedules: HuddleSchedules;
  readonly filetrees: HuddleFiletrees;
  private readonly database: HuddleStateDatabase;

  constructor(
    home: string,
    identity: HuddleLedgerIdentity,
    limits?: { bytes?: number; records?: number },
  ) {
    this.database = new HuddleStateDatabase(home, identity, limits);
    this.executions = new HuddleExecutions(this.database);
    this.invocations = new HuddleInvocations(this.database, this.executions);
    this.operations = new HuddleOperations(this.database, this.executions, this.invocations);
    this.activations = new HuddleActivations(this.database);
    this.intervals = new HuddleIntervals(this.database, this.executions, this.activations);
    this.schedules = new HuddleSchedules(this.database, this.executions, this.activations);
    this.filetrees = new HuddleFiletrees(this.database, this.executions, this.activations);
  }

  page(
    collection: HuddleCollection,
    filter: { parent?: string; state?: string; after?: number } = {},
  ): LedgerRow[] {
    return this.database.list(collection, filter);
  }

  usage() {
    return this.database.usage();
  }
  get identity(): HuddleLedgerIdentity {
    return { ...this.database.identity };
  }
  graph(
    revision: string,
    definition: HuddleDefinition,
    components: ReadonlyMap<string, HuddleComponent>,
  ) {
    return new HuddleGraphRouting(
      this.database,
      this.executions,
      this.invocations,
      revision,
      definition,
      components,
    );
  }
  close() {
    this.database.close();
  }

  /** Called only after the lifecycle owner has positively fenced the outgoing workers. */
  recoverOwnerLoss(): string[] {
    const interrupted: string[] = [];
    this.scan('executions', { state: 'running' }, (row) => {
      const execution = huddleExecutionRecordSchema.parse(JSON.parse(row.body));
      this.interrupt(
        execution.id,
        'interrupted',
        'Huddle owner ended; script bodies were not replayed',
      );
      interrupted.push(execution.id);
    });
    return interrupted;
  }

  /** Records cancellation intent; actual child/agent termination belongs to the owner controls. */
  interrupt(
    executionId: string,
    state: 'cancelled' | 'interrupted' | 'failed',
    reason: string,
  ): void {
    this.database.atomic(() => {
      const execution = this.executions.get(executionId);
      if (!['pending', 'running'].includes(execution.state)) {
        if (execution.state === state && execution.error === reason) return;
        throw new Error('Execution already has a different terminal outcome');
      }
      // Release the root's terminal-outcome reservation within the same transaction.
      // Subsequent cancellation writes cannot expose a partially stopped graph.
      this.executions.finish(executionId, state, reason);
      this.scan('operations', { parent: executionId }, (row) => {
        const operation = huddleOperationRecordSchema.parse(JSON.parse(row.body));
        if (operation.state === 'prepared') this.operations.cancelUnsent(operation.id);
        else if (operation.state === 'dispatched') this.operations.unknown(operation.id, reason);
      });
      this.scan('invocations', { parent: executionId }, (row) => {
        const invocation = huddleInvocationRecordSchema.parse(JSON.parse(row.body));
        if (['pending', 'running'].includes(invocation.state))
          this.invocations.finish(
            invocation.id,
            invocation.state === 'pending' ? 'cancelled' : state,
            reason,
          );
      });
      this.scan('emissions', { parent: executionId, state: 'pending' }, (row) => {
        const emission = huddleEmissionRecordSchema.parse(JSON.parse(row.body));
        this.database.put('emissions', row.id, executionId, 'cancelled', {
          ...emission,
          state: 'cancelled',
        });
      });
      this.scan('joins', { parent: executionId, state: 'waiting' }, (row) => {
        const record = huddleJoinRecordSchema.parse(JSON.parse(row.body));
        this.database.put('joins', row.id, executionId, 'cancelled', {
          ...record,
          state: 'cancelled',
        });
      });
    });
  }

  private scan(
    collection: HuddleCollection,
    filter: { parent?: string; state?: string },
    visit: (row: LedgerRow) => void,
  ): void {
    let after = 0;
    for (;;) {
      const rows = this.database.list(collection, { ...filter, after });
      if (!rows.length) return;
      for (const row of rows) {
        visit(row);
        after = row.ordinal;
      }
    }
  }
}
