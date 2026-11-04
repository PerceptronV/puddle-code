import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HostUpdateOperations } from '../../../../daemon/src/updates/operations/store.js';
import { HostConnection } from '../../../src/lib/auth/connection-authority.js';
import * as controlChannel from '../../../src/lib/auth/control-channel.js';
import { CockpitHostUpdates } from '../../../src/lib/host/updates/cockpit.js';
import { LocalTransport } from '../../../src/lib/transport/local.js';
import { presentHostUpdate } from '../../../src/lib/host/updates/presentation.js';
import { inspectStoredHostUpdate } from '../../../src/lib/host/updates/inspection.js';

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-cockpit-offline-'));
  homes.push(home);
  vi.stubEnv('PUDDLE_HOME', home);
  const store = new HostUpdateOperations(home);
  const operation = store.begin([{ component: 'daemon', version: '0.4.0' }]).operation;
  const transport = new LocalTransport();
  const authority = new HostConnection(transport);
  authority.close(); // No automatic reconnection outside this isolated fixture.
  const live = vi.spyOn(authority, 'hostUpdate');
  const exec = vi.spyOn(transport, 'exec');
  const control = new CockpitHostUpdates(transport, authority);
  const signal = new AbortController();
  return { home, store, operation, authority, live, exec, control, signal };
}

it('reads exact current and historical records without a daemon, database or lease', async () => {
  const f = fixture();
  const cancelled = f.store.stopBeforeDispatch(f.operation, 'cancelled', 'fixture');
  const current = f.store.begin(f.operation.targets).operation;
  const ledger = join(f.home, 'updates/operations.json');
  const before = readFileSync(ledger);
  for (const [id, operation] of [
    [undefined, current],
    [cancelled.id, cancelled],
  ] as const) {
    expect(await f.control.status(id, () => true, f.signal.signal)).toEqual({
      availability: 'unavailable',
      observation: 'recorded',
      daemon_version: null,
      capabilities: {
        interruption_approval: false,
        verify_completion: false,
        continue_recovery: false,
      },
      result: presentHostUpdate({ ok: true, operation }),
    });
  }
  expect(readFileSync(ledger)).toEqual(before);
  expect(f.live).not.toHaveBeenCalled();
  expect(f.exec).not.toHaveBeenCalled();
  for (const name of ['puddle.db', 'runtime.json', 'token', 'supervisor'])
    expect(existsSync(join(f.home, name))).toBe(false);
});

it('revokes offline continuation if the parent reconnects during helper work', async () => {
  const f = fixture();
  let changed = () => {};
  vi.spyOn(f.authority, 'onChange').mockImplementation((listener) => {
    changed = listener;
    return () => {};
  });
  const continueUpdate = vi
    .spyOn(controlChannel, 'continueHostUpdate')
    .mockImplementationOnce(async (_transport, _reference, participation) => {
      expect(participation!.signal.aborted).toBe(false);
      vi.spyOn(f.authority, 'state', 'get').mockReturnValue('ready');
      changed();
      expect(participation!.signal.aborted).toBe(true);
      expect(participation!.authorised()).toBe(false);
      return { ok: true, operation: f.operation };
    });
  await expect(
    f.control.request(
      {
        action: 'continue-offline',
        reference: { id: f.operation.id, revision: f.operation.revision },
      },
      () => true,
      f.signal.signal,
    ),
  ).rejects.toThrow('authority changed');
  expect(continueUpdate).toHaveBeenCalledOnce();
  expect(f.exec).not.toHaveBeenCalled();
});

it.each(['ready', 'protocol_mismatch'] as const)(
  'refuses offline dispatch on a %s connection',
  async (state) => {
    const f = fixture();
    vi.spyOn(f.authority, 'state', 'get').mockReturnValue(state);
    const continueUpdate = vi.spyOn(controlChannel, 'continueHostUpdate');
    await expect(
      f.control.request(
        {
          action: 'continue-offline',
          reference: { id: f.operation.id, revision: f.operation.revision },
        },
        () => true,
        f.signal.signal,
      ),
    ).rejects.toThrow('unavailable daemon');
    expect(continueUpdate).not.toHaveBeenCalled();
  },
);

it('keeps corrupt recorded state distinct from an empty update history', async () => {
  const f = fixture();
  writeFileSync(join(f.home, 'updates/operations.json'), '{', { mode: 0o600 });
  expect(await f.control.status(undefined, () => true, f.signal.signal)).toMatchObject({
    availability: 'unavailable',
    observation: 'recorded',
    result: { ok: false, code: 'failed', operation: null },
  });
  expect(f.exec).not.toHaveBeenCalled();
});

it.each(['revoked', 'aborted', 'reconnected'] as const)(
  'discards an offline reply if browser or host authority is %s during inspection',
  async (change) => {
    const f = fixture();
    let authorised = true;
    const inspect = vi
      .spyOn(controlChannel, 'inspectHostUpdate')
      .mockImplementationOnce(async () => {
        if (change === 'revoked') authorised = false;
        if (change === 'aborted') f.signal.abort();
        if (change === 'reconnected')
          vi.spyOn(f.authority, 'state', 'get').mockReturnValue('ready');
        return inspectStoredHostUpdate(f.home, { action: 'status' });
      });
    await expect(f.control.status(undefined, () => authorised, f.signal.signal)).rejects.toThrow();
    expect(inspect).toHaveBeenCalledExactlyOnceWith(expect.any(LocalTransport), undefined, true);
    expect(f.exec).not.toHaveBeenCalled();
  },
);

it('rejects already-revoked requests before reading and never uses offline inspection for mutations', async () => {
  const f = fixture();
  const inspect = vi.spyOn(controlChannel, 'inspectHostUpdate');
  await expect(f.control.status(undefined, () => false, f.signal.signal)).rejects.toThrow();
  f.signal.abort();
  await expect(f.control.status(undefined, () => true, f.signal.signal)).rejects.toThrow();
  await expect(
    f.control.request(
      {
        action: 'recover',
        reference: { id: f.operation.id, revision: f.operation.revision },
        strategy: 'continue',
      },
      () => true,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(inspect).not.toHaveBeenCalled();
  expect(f.exec).not.toHaveBeenCalled();
});
