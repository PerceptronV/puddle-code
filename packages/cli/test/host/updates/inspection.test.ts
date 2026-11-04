import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inspectStoredHostUpdate } from '../../../src/lib/host/updates/inspection.js';
import { HostUpdateOperations } from '../../../../daemon/src/updates/operations/store.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it('reads current and historical operations while refusing mutation and adoption requests', () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-update-inspection-'));
  homes.push(home);
  const store = new HostUpdateOperations(home);
  const first = store.begin([{ component: 'runtime', version: '0.4.0' }]).operation;
  const cancelled = store.stopBeforeDispatch(first, 'cancelled', 'fixture');
  const current = store.begin(first.targets).operation;
  const before = readFileSync(join(home, 'updates/operations.json'));
  expect(inspectStoredHostUpdate(home, { action: 'status' })).toEqual({
    ok: true,
    operation: current,
  });
  expect(inspectStoredHostUpdate(home, { action: 'status', id: first.id })).toEqual({
    ok: true,
    operation: cancelled,
  });
  expect(inspectStoredHostUpdate(home, { action: 'status', id: randomUUID() })).toEqual({
    ok: true,
    operation: null,
  });
  for (const command of [
    { action: 'status' as const, id: current.id, adoption_nonce: randomUUID() },
    {
      action: 'cancel' as const,
      reference: { id: current.id, revision: current.revision },
      reason: 'cancelled' as const,
    },
    {
      action: 'recover' as const,
      reference: { id: current.id, revision: current.revision },
      strategy: 'verify-completion' as const,
    },
  ])
    expect(inspectStoredHostUpdate(home, command)).toEqual({
      ok: false,
      code: 'unsupported',
      operation: null,
    });
  expect(readFileSync(join(home, 'updates/operations.json'))).toEqual(before);
});
