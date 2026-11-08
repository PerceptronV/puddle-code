import {
  huddleEmissionRecordSchema,
  huddleExecutionRecordSchema,
  huddleInvocationRecordSchema,
  huddleOperationRecordSchema,
  type HuddleLedgerIdentity,
} from '@puddle/shared';
import { HuddleStateDatabase, type HuddleCollection, type LedgerRow } from './database.js';
import { HuddleExecutions } from './executions.js';
import { HuddleInvocations } from './invocations.js';
import { HuddleOperations } from './operations.js';

/** Owner-local durable execution authority; application SQLite remains daemon-owned. */
export class HuddleLedger {
  readonly executions: HuddleExecutions;
  readonly invocations: HuddleInvocations;
  readonly operations: HuddleOperations;
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
  interrupt(executionId: string, state: 'cancelled' | 'interrupted', reason: string): void {
    this.database.atomic(() => {
      const execution = this.executions.get(executionId);
      if (!['pending', 'running'].includes(execution.state)) {
        if (execution.state === state && execution.error === reason) return;
        throw new Error('Execution already has a different terminal outcome');
      }
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
      this.executions.finish(executionId, state, reason);
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
