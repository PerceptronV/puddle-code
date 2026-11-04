import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  HOST_UPDATE_HISTORY_LIMIT,
  HOST_UPDATE_RECORD_BYTES,
  type HostStageReceipt,
  type HostUpdateOperation,
} from '@puddle/shared';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import { HostUpdateOperations, HostUpdateConflict } from '../../../src/updates/operations/store.js';
import { HostClaimBusy } from '../../../src/security/claims.js';

const homes: string[] = [];
const impact = digest('checked host impact');
const verified = digest('verified actual installation and adoption');
function fixture(options: ConstructorParameters<typeof HostUpdateOperations>[1] = {}) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-update-operations-'));
  homes.push(home);
  return {
    home,
    store: new HostUpdateOperations(home, options),
    file: join(home, 'updates', 'operations.json'),
  };
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function stage(component: 'daemon' | 'runtime' = 'runtime', version = '1.2.3'): HostStageReceipt {
  const record = {
    format: 1 as const,
    component,
    generation: `${version}~ABC123`,
    version,
    protocol: { major: component === 'runtime' ? 1 : 25, minor: 0 },
    archive_sha256: digest('archive'),
    tree_sha256: digest('tree'),
    checksum_verified: true,
  };
  return { record, digest: digest(`${JSON.stringify(record)}\n`) };
}
function approved(store: HostUpdateOperations): HostUpdateOperation {
  let operation = store.begin([{ component: 'runtime', version: '1.2.3' }]).operation;
  operation = store.staged(operation, stage());
  operation = store.preflight(operation, impact);
  return store.approve(operation, impact);
}

it('coalesces the active target and exposes durable progress to replacement controllers', () => {
  const { store, home } = fixture();
  const first = store.begin([{ component: 'runtime', version: '1.2.3' }]);
  expect(first.created).toBe(true);
  const next = new HostUpdateOperations(home);
  expect(next.begin(first.operation.targets)).toEqual({
    operation: first.operation,
    created: false,
  });
  expect(() => next.begin([{ component: 'daemon', version: '1.2.3' }])).toThrow(HostUpdateConflict);
  const downloading = store.downloading(first.operation);
  expect(next.read(first.operation.id)).toEqual(downloading);
  expect(() => next.staged(first.operation, stage())).toThrow(HostUpdateConflict);
  const staged = next.staged(downloading, stage());
  expect(staged.phase).toBe('staged');
  expect(store.read()).toEqual(staged);
});

it('records each exact component stage and rejects mismatches before approval', () => {
  const { store } = fixture();
  const first = store.begin([
    { component: 'runtime', version: '2.3.4' },
    { component: 'daemon', version: '1.2.3' },
  ]).operation;
  expect(() => store.staged(first, stage('runtime'))).toThrow();
  expect(store.read()).toEqual(first);
  const partial = store.staged(first, stage('daemon'));
  expect(partial.phase).toBe('downloading');
  expect(() => store.staged(partial, stage('daemon'))).toThrow();
  expect(() => store.preflight(partial, impact)).toThrow();
  const full = store.staged(partial, stage('runtime', '2.3.4'));
  expect(full.phase).toBe('staged');
  expect(() => store.approve(full, impact)).toThrow();
});

it('binds approval to fresh preflight and dispatches only once', () => {
  const { store } = fixture();
  const approval = approved(store);
  const changed = store.preflight(approval, digest('changed impact'));
  expect(changed.approved).toBeNull();
  expect(() => store.dispatch(approval)).toThrow();
  expect(() => store.approve(changed, impact)).toThrow();
  const next = store.approve(changed, changed.preflight!);
  const dispatch = store.dispatch(next);
  expect(dispatch.dispatch_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(() => store.dispatch(next)).toThrow();
  expect(() => store.dispatch(dispatch)).toThrow();
  expect(() => store.stopBeforeDispatch(dispatch, 'cancelled', 'late cancellation')).toThrow();
});

it('rejects unverified stages and retains superseded stages for later reference collection', () => {
  const { store } = fixture();
  const operation = store.begin([{ component: 'runtime', version: '1.2.3' }]).operation;
  const unverified = stage();
  unverified.record.checksum_verified = false;
  unverified.digest = digest(`${JSON.stringify(unverified.record)}\n`);
  expect(() => store.staged(operation, unverified)).toThrow();
  expect(store.read()).toEqual(operation);
  const staged = store.staged(operation, stage());
  store.stopBeforeDispatch(staged, 'superseded', 'a newer release was offered');
  expect(store.begin([{ component: 'runtime', version: '2.3.4' }]).created).toBe(true);
  expect(store.read(operation.id)?.stages).toEqual([stage()]);
});

it('requires the exact dispatch and preflight, an exclusive worker and positive verification', () => {
  const { store, home } = fixture();
  const dispatch = store.dispatch(approved(store));
  expect(() => store.claimExecution(dispatch, randomUUID(), impact)).toThrow();
  expect(() =>
    store.claimExecution(dispatch, dispatch.dispatch_id!, digest('other impact')),
  ).toThrow();
  const worker = store.claimExecution(dispatch, dispatch.dispatch_id!, impact);
  try {
    expect(worker.operation.phase).toBe('applying');
    const other = new HostUpdateOperations(home);
    expect(() => other.claimExecution(dispatch, dispatch.dispatch_id!, impact)).toThrow(
      HostClaimBusy,
    );
    expect(() => other.requireRecovery(worker.operation, 'still alive')).toThrow(HostClaimBusy);
    expect(() => worker.complete(verified)).toThrow();
    worker.verifying();
    expect(() => worker.complete('')).toThrow();
    expect(worker.complete(verified).phase).toBe('complete');
    expect(() => store.begin(dispatch.targets)).toThrow(HostClaimBusy);
  } finally {
    worker.release();
  }
  worker.release();
  expect(() => worker.verifying()).toThrow('released');
  expect(store.begin(dispatch.targets).created).toBe(true);
  expect(store.read(dispatch.id)?.phase).toBe('complete');
});

it.each(['applying', 'verifying'] as const)('never replays an abandoned worker in %s', (phase) => {
  const { store, home } = fixture();
  const dispatch = store.dispatch(approved(store));
  const worker = store.claimExecution(dispatch, dispatch.dispatch_id!, impact);
  if (phase === 'verifying') worker.verifying();
  worker.release();
  const replacement = new HostUpdateOperations(home);
  const current = replacement.read()!;
  expect(current.phase).toBe(phase);
  expect(() => replacement.claimExecution(current, dispatch.dispatch_id!, impact)).toThrow();
  const recovery = replacement.requireRecovery(current, 'worker ended before verification');
  expect(replacement.begin(dispatch.targets)).toEqual({ operation: recovery, created: false });
  expect(() => replacement.begin([{ component: 'runtime', version: '2.3.4' }])).toThrow();
  expect(() => replacement.resolveRecovery(recovery, 'complete', '')).toThrow();
  expect(replacement.resolveRecovery(recovery, 'rolled_back', verified).phase).toBe('rolled_back');
});

it('fences a delayed unstarted worker before recording verified recovery', () => {
  const { store } = fixture();
  const dispatch = store.dispatch(approved(store));
  const fenced = store.requireRecovery(dispatch, 'dispatch outcome unknown');
  expect(() => store.claimExecution(fenced, dispatch.dispatch_id!, impact)).toThrow();
  expect(() => store.resolveRecovery(fenced, 'complete', verified)).toThrow();
  const resolved = store.resolveRecovery(fenced, 'rolled_back', verified);
  store.begin(dispatch.targets);
  expect(store.read(resolved.id)?.phase).toBe('rolled_back');
  expect(() => store.claimExecution(dispatch, dispatch.dispatch_id!, impact)).toThrow();
});

it('retains failures after execution as recovery-required, without permitting another operation', () => {
  const { store } = fixture();
  const dispatch = store.dispatch(approved(store));
  const worker = store.claimExecution(dispatch, dispatch.dispatch_id!, impact);
  try {
    expect(worker.failed('activation acknowledgement lost').phase).toBe('recovery_required');
  } finally {
    worker.release();
  }
  expect(() => store.stopBeforeDispatch(store.read()!, 'failed', 'discard')).toThrow();
  expect(store.begin(dispatch.targets).created).toBe(false);
});

it.each(['before', 'after'] as const)(
  'keeps dispatch uncertainty inspectable when persistence fails %s rename',
  (timing) => {
    let fail = false;
    const { store, home } = fixture({
      write(file, value, options) {
        if (fail && timing === 'before') throw new Error('disk unavailable');
        atomicPrivateJson(file, value, options);
        if (fail) throw new Error('directory sync response lost');
      },
    });
    const approval = approved(store);
    fail = true;
    expect(() => store.dispatch(approval)).toThrow();
    const replacement = new HostUpdateOperations(home);
    expect(replacement.read()?.phase).toBe(timing === 'before' ? 'approved' : 'dispatching');
    if (timing === 'after') expect(() => replacement.dispatch(approval)).toThrow();
  },
);

it('bounds completed history while retaining the current unknown outcome', () => {
  const { store, file } = fixture();
  const ids: string[] = [];
  for (let i = 0; i < HOST_UPDATE_HISTORY_LIMIT + 3; i++) {
    const operation = store.begin([{ component: 'runtime', version: '1.2.3' }]).operation;
    ids.push(operation.id);
    store.stopBeforeDispatch(operation, 'cancelled', 'cancelled before dispatch');
  }
  const dispatch = store.dispatch(approved(store));
  const recovery = store.requireRecovery(dispatch, 'uncertain dispatch');
  const ledger = JSON.parse(readFileSync(file, 'utf8')) as { history: unknown[] };
  expect(ledger.history).toHaveLength(HOST_UPDATE_HISTORY_LIMIT);
  expect(store.read(ids[0]!)).toBeNull();
  expect(store.read(recovery.id)).toEqual(recovery);
  expect(() => store.claimExecution({ id: ids[0]!, revision: 1 }, randomUUID(), impact)).toThrow();
});

it.each(['oversized', 'symlink', 'shared', 'corrupt', 'receipt'])(
  'fails closed on a %s ledger',
  (kind) => {
    const { store, file, home } = fixture();
    approved(store);
    if (kind === 'oversized') writeFileSync(file, ' '.repeat(HOST_UPDATE_RECORD_BYTES + 1));
    if (kind === 'shared') chmodSync(file, 0o644);
    if (kind === 'corrupt') writeFileSync(file, '{');
    if (kind === 'receipt') {
      const value = JSON.parse(readFileSync(file, 'utf8')) as { current: HostUpdateOperation };
      value.current.stages[0]!.record.tree_sha256 = digest('changed');
      atomicPrivateJson(file, value);
    }
    if (kind === 'symlink') {
      rmSync(file);
      symlinkSync(join(home, 'elsewhere'), file);
    }
    expect(() => store.read()).toThrow();
    expect(() => store.begin([{ component: 'runtime', version: '1.2.3' }])).toThrow();
  },
);
