import { join } from 'node:path';
import { hostUpdateOperationSchema, type HostUpdateOperation } from '@puddle/shared';
import { readHostUpdateLedger } from '@puddle/shared/node/host-control';
import { readRetainedUpdate } from '../../../../updates/operations/retained.js';
import { boundedFiles } from '../inventory.js';
import type { CollectionBudget } from '../budget.js';
import { updateReleaseRetired } from './updates.js';

/** Current selection and the last successful predecessor remain available as rollback pins. */
export async function collectionOperations(
  home: string,
  requireCurrent: () => void,
  budget: CollectionBudget,
) {
  budget.record(join(home, 'updates/operations.json'));
  const ledger = readHostUpdateLedger(home);
  const operations = new Map<string, HostUpdateOperation>();
  for (const operation of [ledger.current, ...ledger.history])
    if (operation) operations.set(operation.id, operation);
  const protectedIds = new Set<string>();
  if (ledger.current) protectedIds.add(ledger.current.id);
  for (const name of await boundedFiles(join(home, 'updates/retained'), requireCurrent, budget)) {
    if (!name.endsWith('.json')) throw new Error('Unknown retained update evidence');
    const id = hostUpdateOperationSchema.shape.id.parse(name.slice(0, -5));
    budget.record(join(home, 'updates/retained', name));
    const operation = readRetainedUpdate(home, id);
    const current = operations.get(id);
    if (current && JSON.stringify(operation) !== JSON.stringify(current))
      throw new Error('Retained update contradicts current ledger');
    operations.set(id, operation);
  }
  // Ledger order is authoritative even when the wall clock moves backwards.
  // Once it has fewer than two successes, older archives have no durable relative
  // ordering. Keep all unretired candidates rather than inventing a predecessor.
  const ordered = [...ledger.history, ...(ledger.current ? [ledger.current] : [])];
  const ledgerIds = new Set(ordered.map(({ id }) => id));
  for (const component of ['daemon', 'runtime'] as const) {
    const matches = (operation: HostUpdateOperation) =>
      operation.phase === 'complete' &&
      operation.targets.some((target) => target.component === component);
    const latest = ordered.filter(matches).slice(-2);
    for (const operation of latest) protectedIds.add(operation.id);
    if (latest.length < 2) {
      for (const operation of operations.values()) {
        requireCurrent();
        if (
          !ledgerIds.has(operation.id) &&
          matches(operation) &&
          !updateReleaseRetired(home, operation, budget)
        )
          protectedIds.add(operation.id);
      }
    }
  }
  return { operations, protectedIds };
}
