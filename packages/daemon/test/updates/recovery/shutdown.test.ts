import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { hostReleaseCapabilities, hostUpdateActionsSchema } from '@puddle/shared';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import type { CompilationCommandRunner } from '../../../src/compilation/process.js';
import { openDatabase } from '../../../src/db/db.js';
import { RuntimeStore } from '../../../src/db/stores/runtimes.js';
import { DATABASE_SCHEMA_VERSION } from '../../../src/db/migrations/index.js';
import { acquireHostClaim, HostClaimBusy } from '../../../src/security/claims.js';
import {
  acquireRuntimeController,
  readRuntimeController,
} from '../../../src/runtime/ownership/storage.js';
import { prepareServiceReplacement } from '../../../src/host/supervision/replacement.js';
import { inspectRunningService } from '../../../src/host/supervision/inspection.js';
import { HostUpdateCheckpointWriter } from '../../../src/updates/checkpoints/store.js';
import { HostUpdateActions } from '../../../src/updates/worker/actions.js';
import { updateWorkerDirectory } from '../../../src/updates/worker/supervisor.js';
import { claimStoppedHostUpdateRecovery } from '../../../src/updates/recovery/shutdown.js';
import { acceptedCheckpointUpdate, checkpointWorker } from '../../helpers/update-checkpoint.js';
import { systemdObservation } from '../../helpers/host-supervision.js';

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-stopped-recovery-'));
  homes.push(home);
  const accepted = acceptedCheckpointUpdate(home);
  const controller = acquireRuntimeController(home);
  const job = checkpointWorker(home, accepted, {
    pid: process.pid,
    controller: { id: controller.record.id, epoch: controller.record.epoch },
  });
  const state = {
    stopped: false,
    definition: '[Service]\nRestart=always\n',
    authorised: true,
    onProbe: () => {},
  };
  const run = vi.fn<CompilationCommandRunner>(async (command) => {
    state.onProbe();
    if (command.args[1] !== 'cat' && command.args[1] !== 'show')
      throw new Error('Recovery must not issue a service mutation');
    return {
      exitCode: 0,
      stderr: '',
      stdout:
        command.args[1] === 'cat'
          ? state.definition
          : state.stopped
            ? 'Id=puddled.service\nLoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nNeedDaemonReload=no\n'
            : systemdObservation(process.pid),
    };
  });
  const target = { kind: 'systemd' as const, name: 'puddled.service', domain: null };
  job.daemon_service = await prepareServiceReplacement(
    home,
    await inspectRunningService(home, target, process.pid, run),
    { run },
  );
  job.connector = { state: 'absent' };
  const directory = updateWorkerDirectory(home, job.operation_id);
  atomicPrivateJson(join(directory, 'worker.json'), job);
  const stage = accepted.operation.stages[0]!;
  const release = join(home, 'bin/versions', stage.record.generation);
  mkdirSync(release, { recursive: true, mode: 0o700 });
  atomicPrivateJson(join(release, '.puddle-stage.json'), stage.record);
  const capabilities = {
    ...hostReleaseCapabilities(stage.record.version, DATABASE_SCHEMA_VERSION),
    application: stage.record.protocol,
  };
  const metadata = join(release, 'HOST_CAPABILITIES.json');
  writeFileSync(metadata, JSON.stringify(capabilities));
  const worker = accepted.store.claimExecution(accepted.operation, job.dispatch_id, job.preflight);
  const actions = new HostUpdateActions(home, job);
  const dbFile = join(home, 'puddle.db');
  const db = openDatabase(dbFile);
  try {
    await actions.run('stop-connector', async () => {});
    await expect(
      actions.run('stop-daemon', async () => {
        new HostUpdateCheckpointWriter(
          { home, db, runtimes: new RuntimeStore(db), version: '0.3.14' },
          accepted.reference,
        ).commit(controller.record);
        controller.release();
        state.stopped = true;
        throw new Error('Stop reply lost');
      }),
    ).rejects.toThrow('Stop reply lost');
    worker.failed('Stop reply lost');
  } finally {
    worker.release();
    controller.release();
    db.close();
  }
  const operation = accepted.store.read()!;
  const group = 2147483647;
  expect(() => process.kill(-group, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
  atomicPrivateJson(join(directory, 'lifetime.json'), {
    format: 1,
    operation_id: operation.id,
    dispatch_id: operation.dispatch_id,
    worker_id: operation.worker_id,
    preflight: operation.approved,
    process_group: group,
  });
  run.mockClear();
  const claim = () =>
    claimStoppedHostUpdateRecovery(home, accepted.store.read()!, () => state.authorised, run);
  return {
    home,
    job,
    directory,
    dbFile,
    state,
    run,
    capabilities,
    metadata,
    claim,
    store: accepted.store,
    checkpoint: join(home, 'updates/checkpoints', `${job.operation_id}.json`),
  };
}

it('recovers the original controller hand-off after a lost stop reply without opening SQLite or issuing component commands', async () => {
  const f = await fixture();
  const before = readRuntimeController(f.home);
  const database = readFileSync(f.dbFile);
  const checkpoint = readFileSync(f.checkpoint);
  const recovery = await f.claim();
  try {
    expect(recovery.actions.actions).toContainEqual({ action: 'stop-daemon', state: 'started' });
    expect(recovery.checkpointDigest).toBe(digest(checkpoint.toString()));
    expect(readRuntimeController(f.home)).toEqual(before);
    for (const scope of [
      'daemon-controller',
      'host-update-execution',
      `host-update-dispatch:${f.job.operation_id}`,
    ])
      expect(() => acquireHostClaim(f.home, scope)).toThrow(HostClaimBusy);
    expect(readFileSync(f.dbFile)).toEqual(database);
    expect(f.store.read()?.phase).toBe('recovery_required');
    expect(f.run.mock.calls.every(([command]) => ['show', 'cat'].includes(command.args[1]!))).toBe(
      true,
    );
  } finally {
    recovery.release();
  }
  expect(() => recovery.check()).toThrow('released');
  for (const scope of [
    'daemon-controller',
    'host-update-execution',
    `host-update-dispatch:${f.job.operation_id}`,
  ])
    acquireHostClaim(f.home, scope).release();
});

it.each([
  'journal',
  'unattempted',
  'checkpoint',
  'controller',
  'active',
  'definition',
  'running',
  'unknown-schema',
  'old-schema',
] as const)(
  'retains recovery and releases all claims after invalid %s evidence',
  async (failure) => {
    const f = await fixture();
    if (failure === 'journal') rmSync(join(f.directory, 'actions.json'));
    if (failure === 'unattempted') {
      const path = join(f.directory, 'actions.json');
      const journal = hostUpdateActionsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      journal.actions[1]!.state = 'planned';
      atomicPrivateJson(path, journal);
    }
    if (failure === 'checkpoint') rmSync(f.checkpoint);
    if (failure === 'controller') acquireRuntimeController(f.home).release();
    if (failure === 'active')
      atomicPrivateJson(join(f.home, 'runtime-controller.json'), {
        ...readRuntimeController(f.home),
        active: true,
      });
    if (failure === 'definition') f.state.definition += '# changed\n';
    if (failure === 'running') f.state.stopped = false;
    if (failure === 'unknown-schema' || failure === 'old-schema') {
      writeFileSync(
        f.metadata,
        JSON.stringify({
          ...f.capabilities,
          database_schema_version: failure === 'unknown-schema' ? undefined : 0,
        }),
      );
    }
    await expect(f.claim()).rejects.toThrow();
    expect(f.store.read()?.phase).toBe('recovery_required');
    for (const scope of [
      'daemon-controller',
      'host-update-execution',
      `host-update-dispatch:${f.job.operation_id}`,
    ])
      acquireHostClaim(f.home, scope).release();
  },
);

it('rechecks authority and worker lifetime after asynchronous supervisor inspection', async () => {
  const f = await fixture();
  f.state.onProbe = () => {
    f.state.authorised = false;
  };
  await expect(f.claim()).rejects.toThrow('authority expired');
  acquireHostClaim(f.home, 'daemon-controller').release();
  f.state.authorised = true;
  f.state.onProbe = () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
  };
  await expect(f.claim()).rejects.toThrow('still running');
  acquireHostClaim(f.home, 'daemon-controller').release();
});
