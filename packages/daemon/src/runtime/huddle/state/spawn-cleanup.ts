import {
  canonicalHuddleJson,
  huddleOperationRecordSchema,
  huddleSpawnCleanupSchema,
  type HuddleSpawnCleanup as Cleanup,
  type HuddleSpawnCleanupOutcome,
} from '@puddle/shared';
import type { HuddleStateDatabase } from './database.js';

/** Separate from readiness: a completed spawn can still require later lifecycle cleanup. */
export class HuddleSpawnCleanup {
  constructor(private readonly db: HuddleStateDatabase) {}

  prepare(id: string, executionId: string) {
    this.save(id, executionId, { state: 'retained' });
  }
  get(id: string): Cleanup {
    const row = this.db.get('spawn-cleanup', id);
    if (!row) throw new Error('Spawn has no retained cleanup reservation');
    return huddleSpawnCleanupSchema.parse(JSON.parse(row.body));
  }
  get pending() {
    return this.db.count('spawn-cleanup', { state: 'pending' });
  }

  request(executionId?: string) {
    this.db.atomic(() => {
      let after = 0;
      for (;;) {
        const rows = this.db.list('spawn-cleanup', {
          parent: executionId,
          state: 'retained',
          after,
        });
        if (!rows.length) break;
        for (const row of rows) {
          after = row.ordinal;
          const operation = huddleOperationRecordSchema.parse(
            JSON.parse(this.db.get('operations', row.id)!.body),
          );
          const unsent =
            !operation.consumed ||
            (operation.state === 'failed' &&
              !!operation.result &&
              typeof operation.result === 'object' &&
              'rejected' in operation.result);
          this.save(
            row.id,
            row.parent,
            unsent ? { state: 'confirmed', outcome: 'unadmitted' } : { state: 'pending' },
          );
        }
      }
    });
  }
  settle(id: string, outcome: HuddleSpawnCleanupOutcome) {
    return this.update(id, { state: 'confirmed', outcome });
  }
  unavailable(id: string, error: string) {
    return this.update(id, { state: 'pending', error });
  }
  private update(id: string, next: Cleanup) {
    return this.db.atomic(() => {
      const before = this.get(id);
      if (canonicalHuddleJson(before) === canonicalHuddleJson(next)) return false;
      if (before.state !== 'pending') throw new Error('Spawn cleanup is not pending');
      const row = this.db.get('spawn-cleanup', id)!;
      this.save(id, row.parent, next);
      return true;
    });
  }
  private save(id: string, executionId: string, raw: Cleanup) {
    const value = huddleSpawnCleanupSchema.parse(raw);
    this.db.put('spawn-cleanup', id, executionId, value.state, value, {
      bytes:
        value.state === 'confirmed'
          ? 0
          : Math.max(0, 32 * 1024 - Buffer.byteLength(JSON.stringify(value))),
    });
  }
}
