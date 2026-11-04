import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, vi } from 'vitest';
import { hostReleaseCapabilities } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import type {
  CompilationCommand,
  CompilationCommandRunner,
} from '../../src/compilation/process.js';
import { openDatabase } from '../../src/db/db.js';
import { RuntimeStore } from '../../src/db/stores/runtimes.js';
import { DATABASE_SCHEMA_VERSION } from '../../src/db/migrations/index.js';
import { acquireRuntimeController } from '../../src/runtime/ownership/storage.js';
import { prepareServiceReplacement } from '../../src/host/supervision/replacement.js';
import { inspectRunningService } from '../../src/host/supervision/inspection.js';
import { HostUpdateCheckpointWriter } from '../../src/updates/checkpoints/store.js';
import { HostUpdateActions } from '../../src/updates/worker/actions.js';
import { updateWorkerDirectory } from '../../src/updates/worker/supervisor.js';
import { claimStoppedHostUpdateRecovery } from '../../src/updates/recovery/shutdown.js';
import { acceptedCheckpointUpdate, checkpointWorker } from './update-checkpoint.js';
import { systemdObservation } from './host-supervision.js';

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

export async function stoppedUpdateRecovery() {
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
    release,
    stage,
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

/** Metadata/supervisor fixture only; never invokes an installed host service. */
export async function recoveryWorkerFixture() {
  const f = await stoppedUpdateRecovery();
  mkdirSync(join(f.release, 'bin'));
  mkdirSync(join(f.release, 'daemon'));
  writeFileSync(join(f.release, 'bin/node'), '', { mode: 0o755 });
  writeFileSync(join(f.release, 'daemon/host-update.mjs'), '');
  writeFileSync(join(f.release, 'daemon/install.sh'), '');
  const commands: CompilationCommand[] = [];
  const run: CompilationCommandRunner = async (command) => {
    if (['cat', 'show'].includes(command.args[1]!)) return f.run(command);
    commands.push(command);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return {
    ...f,
    commands,
    supervisor: run,
    options: { releasePath: f.release, authorised: () => f.state.authorised, run },
  };
}
