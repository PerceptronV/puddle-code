import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { hostUpdateOperationSchema } from '@puddle/shared';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import { retainTerminalUpdate } from '../../../../src/updates/operations/retained.js';
import { collectionOperations } from '../../../../src/host/installation/collection/retirement/operations.js';
import { CollectionBudget } from '../../../../src/host/installation/collection/budget.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-rollback-pins-'));
  homes.push(home);
  return home;
}
function operation(
  time: number,
  phase: 'complete' | 'cancelled' | 'failed',
  components: Array<'daemon' | 'runtime'> = ['daemon'],
) {
  return hostUpdateOperationSchema.parse({
    format: 1,
    id: randomUUID(),
    revision: 12,
    created_at: time,
    updated_at: time,
    phase,
    targets: components.map((component) => ({ component, version: '0.4.0' })),
    stages:
      phase === 'complete'
        ? components.map((component) => {
            const record = {
              format: 1,
              component,
              generation: '0.4.0~abc123',
              version: '0.4.0',
              protocol: { major: 26, minor: 0 },
              archive_sha256: 'a'.repeat(64),
              tree_sha256: 'b'.repeat(64),
              checksum_verified: true,
            };
            return { record, digest: digest(`${JSON.stringify(record)}\n`) };
          })
        : [],
    preflight: phase === 'complete' ? 'a'.repeat(64) : null,
    approved: phase === 'complete' ? 'a'.repeat(64) : null,
    dispatch_id: phase === 'complete' ? randomUUID() : null,
    worker_id: phase === 'complete' ? randomUUID() : null,
    verification: phase === 'complete' ? 'a'.repeat(64) : null,
    message: null,
  });
}
it.each(['cancelled', 'failed'] as const)(
  'retains both successful predecessors after a %s attempt and history eviction',
  async (phase) => {
    const home = fixture();
    const older = operation(1, 'complete');
    const a = operation(2, 'complete');
    const b = operation(3, 'complete');
    const c = operation(4, phase);
    atomicPrivateJson(join(home, 'updates/operations.json'), {
      format: 1,
      current: c,
      history: [older, a, b],
    });
    const read = () => collectionOperations(home, () => {}, new CollectionBudget());
    expect((await read()).protectedIds).toEqual(new Set([c.id, a.id, b.id]));
    for (const completed of [older, a, b]) retainTerminalUpdate(home, completed);
    atomicPrivateJson(join(home, 'updates/operations.json'), {
      format: 1,
      current: c,
      history: [],
    });
    expect((await read()).protectedIds).toEqual(new Set([c.id, older.id, a.id, b.id]));
  },
);

it('keeps two successes per component, including combined updates and timestamp ties', async () => {
  const home = fixture();
  const daemonA = operation(1, 'complete');
  const combined = operation(2, 'complete', ['daemon', 'runtime']);
  const runtimeA = operation(3, 'complete', ['runtime']);
  const runtimeB = operation(4, 'complete', ['runtime']);
  const runtimeTie = operation(3, 'complete', ['runtime']);
  const current = operation(5, 'cancelled', ['runtime']);
  atomicPrivateJson(join(home, 'updates/operations.json'), { format: 1, current, history: [] });
  for (const old of [daemonA, combined, runtimeA, runtimeB, runtimeTie])
    retainTerminalUpdate(home, old);
  expect((await collectionOperations(home, () => {}, new CollectionBudget())).protectedIds).toEqual(
    new Set([current.id, daemonA.id, combined.id, runtimeA.id, runtimeB.id, runtimeTie.id]),
  );
});

it('uses successful ledger order rather than wall-clock order after clock rollback', async () => {
  const home = fixture();
  const a = operation(100, 'complete');
  const b = operation(200, 'complete');
  const c = operation(50, 'complete');
  const d = operation(60, 'complete');
  atomicPrivateJson(join(home, 'updates/operations.json'), {
    format: 1,
    current: d,
    history: [a, b, c],
  });
  expect((await collectionOperations(home, () => {}, new CollectionBudget())).protectedIds).toEqual(
    new Set([c.id, d.id]),
  );
});
