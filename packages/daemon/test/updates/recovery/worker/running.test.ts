import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  hostConnectorReplacementSchema,
  hostUpdateActionsSchema,
  type HostUpdateAdoption,
} from '@puddle/shared';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import {
  acquireRuntimeController,
  readRuntimeController,
} from '../../../../src/runtime/ownership/storage.js';
import { writeRuntime } from '../../../../src/runtime-file.js';
import { resolvePaths } from '../../../../src/paths.js';
import { HostUpdateConnector } from '../../../../src/updates/preflight/connector.js';
import * as adoptionVerification from '../../../../src/updates/verification/adoption.js';
import * as lifetime from '../../../../src/updates/worker/lifetime.js';
import { startUpdateRecoveryWorker } from '../../../../src/updates/recovery/worker/supervisor.js';
import { executeUpdateRecovery } from '../../../../src/updates/recovery/worker/execute.js';
import { recoveryWorkerFixture } from '../../../helpers/update-recovery.js';
import { systemdObservation } from '../../../helpers/host-supervision.js';
import { DATABASE_SCHEMA_VERSION } from '../../../../src/db/migrations/index.js';

/** Real records/claims/service validation; daemon authority and supervisor processes are fixtures. */
async function fixture(start: 'started' | 'finished' = 'started', connector = false) {
  const f = await recoveryWorkerFixture();
  const file = join(f.directory, 'actions.json');
  const actions = hostUpdateActionsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  for (const action of actions.actions) {
    if (action.action === 'start-connector') break;
    action.state = action.action === 'start-daemon' ? start : 'finished';
  }
  atomicPrivateJson(file, actions);
  symlinkSync(f.release, join(f.home, 'bin/current'));
  f.state.stopped = false;
  const controller = acquireRuntimeController(f.home);
  onTestFinished(() => controller.release());
  writeRuntime(resolvePaths(f.home), { pid: process.pid, port: 7434 });
  const root = realpathSync(f.release);
  const adoption: HostUpdateAdoption = {
    format: 1,
    operation_id: f.job.operation_id,
    dispatch_id: f.job.dispatch_id,
    preflight: f.job.preflight,
    nonce: randomUUID(),
    checkpoint: digest('authority fixture checkpoint'),
    stage: f.stage.digest,
    observed_at: Date.now(),
    owners: [],
    daemon: {
      pid: process.pid,
      port: 7434,
      version: f.stage.record.version,
      protocol: f.stage.record.protocol,
      schema_version: DATABASE_SCHEMA_VERSION,
      controller: { id: controller.record.id, epoch: controller.record.epoch },
      release_path: root,
      node_path: join(root, 'bin/node'),
      entry_path: join(root, 'daemon/puddled.mjs'),
    },
  };
  const verify = vi
    .spyOn(adoptionVerification, 'verifyHostUpdateAdoption')
    .mockResolvedValue(adoption);
  vi.spyOn(lifetime, 'inspectUpdateWorkerProcessGroup').mockResolvedValue(2147483647);
  const approved = hostConnectorReplacementSchema.parse({
    state: 'running',
    identity: {
      instance: randomUUID(),
      ready: true,
      pid: 2147483647,
      version: f.stage.record.version,
      application: f.capabilities.application,
      remote: f.capabilities.remote,
      release_path: root,
      node_path: join(root, 'bin/node'),
      entry_path: join(root, 'daemon/connector.mjs'),
    },
    service: {
      component: 'connector',
      kind: 'systemd',
      name: 'puddle-connector.service',
      domain: null,
      pid: 2147483647,
      invocation: 'a'.repeat(32),
      controlGroup: '/user.slice/puddle-connector.service',
      definition_path: null,
      definition_digest: digest('connector fixture'),
    },
  });
  if (approved.state !== 'running') throw new Error('Invalid fixture');
  if (connector) {
    f.job.connector = approved;
    atomicPrivateJson(join(f.directory, 'worker.json'), f.job);
  }
  const replacement = structuredClone(approved);
  replacement.identity.instance = randomUUID();
  const state = { connectorRunning: false, loseStartReply: false, changes: [] as string[] };
  vi.spyOn(HostUpdateConnector.prototype, 'inspect').mockImplementation(async () => {
    if (!connector) return { state: 'absent', identity: null, blockers: [] };
    if (state.connectorRunning) return { ...replacement, blockers: [] };
    return {
      state: 'unknown',
      identity: null,
      blockers: [{ code: 'connector_inventory_unknown', target: 'connector' }],
    };
  });
  const run: typeof f.supervisor = async (command) => {
    if (!command.args.includes(approved.service.name)) return f.run(command);
    let stdout = '';
    const action = command.args[1];
    if (action === 'cat') stdout = 'connector fixture';
    else if (action === 'show')
      stdout = state.connectorRunning
        ? systemdObservation(2147483647, approved.service.name)
        : `Id=${approved.service.name}\nLoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nNeedDaemonReload=no\n`;
    else if (action === 'start') {
      state.changes.push('start-connector');
      state.connectorRunning = true;
      if (state.loseStartReply) throw new Error('Connector start reply lost');
    } else throw new Error('Unexpected component mutation');
    return { exitCode: 0, stdout, stderr: '' };
  };
  return { ...f, actions, controller, verify, running: state, run, replacement };
}

it.each(['started', 'finished'] as const)(
  'observes a %s daemon start without another start, selection or controller epoch',
  async (start) => {
    const f = await fixture(start);
    const controller = readRuntimeController(f.home);
    const job = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
    await executeUpdateRecovery(f.home, job, f.run);
    expect(f.store.read()?.phase).toBe('complete');
    expect(readRuntimeController(f.home)).toEqual(controller);
    expect(f.running.changes).toEqual([]);
    expect(f.verify).toHaveBeenCalledTimes(3); // Dispatch, independent execution and completion.
  },
);

it('starts only the pending connector and observes a lost reply on the next explicit attempt', async () => {
  const f = await fixture('finished', true);
  const job = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
  f.running.loseStartReply = true;
  await expect(executeUpdateRecovery(f.home, job, f.run)).rejects.toThrow('start reply lost');
  expect(f.running.changes).toEqual(['start-connector']);
  expect(f.store.read()?.phase).toBe('recovery_required');
  const next = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
  await executeUpdateRecovery(f.home, next, f.run);
  expect(f.running.changes).toEqual(['start-connector']);
  expect(f.store.read()?.phase).toBe('complete');
});

it('does not replay an attempted connector start when its process is no longer running', async () => {
  const f = await fixture('finished', true);
  f.actions.actions.at(-1)!.state = 'started';
  atomicPrivateJson(join(f.directory, 'actions.json'), f.actions);
  const job = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
  await expect(executeUpdateRecovery(f.home, job, f.run)).rejects.toThrow(
    'not established readiness',
  );
  expect(f.running.changes).toEqual([]);
  expect(f.store.read()?.phase).toBe('recovery_required');
});

it.each(['adoption', 'configuration', 'stopped'])(
  'refuses dispatch when replacement %s is unconfirmed',
  async (failure) => {
    const f = await fixture();
    if (failure === 'adoption') f.verify.mockRejectedValueOnce(new Error('Adoption unavailable'));
    if (failure === 'configuration') f.state.definition += 'Changed=yes\n';
    if (failure === 'stopped') f.state.stopped = true;
    await expect(startUpdateRecoveryWorker(f.home, f.store.read()!, f.options)).rejects.toThrow();
    expect(f.commands).toEqual([]);
    expect(f.running.changes).toEqual([]);
  },
);

it.each(['authority', 'selection'])(
  'rechecks replacement %s immediately before issuing a connector start',
  async (change) => {
    const f = await fixture('finished', true);
    const job = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
    let stoppedProbes = 0;
    await expect(
      executeUpdateRecovery(f.home, job, async (command) => {
        const result = await f.run(command);
        if (command.args[1] === 'show' && command.args.includes('puddle-connector.service')) {
          // Initial observation, pre-start observation, then the shared start helper's final probe.
          if (++stoppedProbes === 3) {
            if (change === 'authority') f.controller.release();
            else rmSync(join(f.home, 'bin/current'));
          }
        }
        return result;
      }),
    ).rejects.toThrow(change === 'authority' ? 'current adoption' : 'ENOENT');
    expect(stoppedProbes).toBe(3);
    expect(f.running.changes).toEqual([]);
    expect(f.store.read()?.phase).toBe('recovery_required');
  },
);
