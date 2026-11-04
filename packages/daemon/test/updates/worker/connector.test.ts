import { randomUUID } from 'node:crypto';
import { realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { hostConnectorReplacementSchema } from '@puddle/shared';
import { digest, ipcPath } from '@puddle/shared/node';
import type { CompilationCommandRunner } from '../../../src/compilation/process.js';
import { acquireRuntimeController } from '../../../src/runtime/ownership/storage.js';
import { HostUpdateConnector } from '../../../src/updates/preflight/connector.js';
import { inspectReplacementConnector } from '../../../src/updates/verification/connector.js';
import {
  stopConnectorForUpdate,
  startConnectorAfterUpdate,
} from '../../../src/updates/worker/connector.js';
import { checkpointWorker } from '../../helpers/update-checkpoint.js';
import { systemdObservation } from '../../helpers/host-supervision.js';
import { candidateFixture } from '../preflight/helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const f = candidateFixture();
  const controller = acquireRuntimeController(f.home);
  cleanups.push(() => controller.release());
  const socketDirectory = dirname(ipcPath(f.home, 'remote'));
  cleanups.push(() => rmSync(socketDirectory, { recursive: true, force: true }));
  let operation = f.store.preflight(f.operation, digest('exact approval'));
  operation = f.store.approve(operation, operation.preflight!);
  operation = f.store.dispatch(operation);
  const job = checkpointWorker(
    f.home,
    {
      store: f.store,
      operation,
      reference: {
        operation_id: operation.id,
        dispatch_id: operation.dispatch_id!,
        preflight: operation.preflight!,
      },
    },
    { pid: process.pid, controller: { id: controller.record.id, epoch: controller.record.epoch } },
  );
  // No real service is mutated. Use a confirmed nonexistent process for exit observation.
  const pid = 2147483647;
  expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
  const root = realpathSync(f.root);
  const approved = hostConnectorReplacementSchema.parse({
    state: 'running',
    identity: {
      instance: randomUUID(),
      ready: true,
      pid,
      version: f.capabilities.version,
      application: f.capabilities.application,
      remote: f.capabilities.remote,
      node_path: join(root, 'bin/node'),
      entry_path: join(root, 'daemon/connector.mjs'),
      release_path: root,
    },
    service: {
      component: 'connector',
      kind: 'systemd',
      name: 'puddle-connector.service',
      domain: null,
      pid,
      invocation: 'a'.repeat(32),
      controlGroup: '/user.slice/puddle-connector.service',
      definition_path: null,
      definition_digest: digest('fixture definition'),
    },
  });
  if (approved.state !== 'running') throw new Error('Invalid fixture');
  job.connector = approved;
  const state = {
    stopped: false,
    fail: '',
    mutations: [] as string[],
    observation: structuredClone(approved),
  };
  const inspect = vi
    .spyOn(HostUpdateConnector.prototype, 'inspect')
    .mockImplementation(async () => ({
      ...state.observation,
      blockers: [],
    }));
  const run: CompilationCommandRunner = async (command) => {
    const action = command.args[1];
    let stdout = '';
    if (action === 'cat') stdout = 'fixture definition';
    else if (action === 'show')
      stdout = state.stopped
        ? 'Id=puddle-connector.service\nLoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nNeedDaemonReload=no\n'
        : systemdObservation(pid, 'puddle-connector.service').replace(
            '/user.slice/user-501.slice/user@501.service/app.slice/',
            '/user.slice/',
          );
    else if (action === 'stop' || action === 'start') {
      state.mutations.push(action);
      state.stopped = action === 'stop';
      if (action === 'start' && state.fail !== 'old-instance')
        state.observation.identity.instance = randomUUID();
      if (state.fail === action) throw new Error('Mutation reply lost');
    } else throw new Error('Unexpected fixture command');
    return { exitCode: 0, stdout, stderr: '' };
  };
  const worker = f.store.claimExecution(operation, job.dispatch_id, job.preflight);
  cleanups.push(() => worker.release());
  return { ...f, job, state, inspect, run, worker, controller };
}

it('stops the exact connector and verifies a fresh process in the selected generation', async () => {
  const f = fixture();
  await stopConnectorForUpdate(f.home, f.job, f.run);
  f.worker.verifying();
  const replacement = await startConnectorAfterUpdate(f.home, f.job, f.stage, f.run);
  expect(replacement.state).toBe('running');
  expect(f.state.mutations).toEqual(['stop', 'start']);
});

it.each(['identity', 'controller'])(
  'rejects changed %s before stopping the connector',
  async (change) => {
    const f = fixture();
    if (change === 'identity') f.state.observation.identity.instance = randomUUID();
    else f.controller.release();
    await expect(stopConnectorForUpdate(f.home, f.job, f.run)).rejects.toThrow('changed');
    expect(f.state.mutations).toEqual([]);
  },
);

it.each(['stop', 'start', 'old-instance'])(
  'does not repeat mutation after %s failure',
  async (failure) => {
    const f = fixture();
    f.state.fail = failure;
    if (failure === 'stop') {
      await expect(stopConnectorForUpdate(f.home, f.job, f.run)).rejects.toThrow('reply lost');
      expect(f.state.mutations).toEqual(['stop']);
    } else {
      await stopConnectorForUpdate(f.home, f.job, f.run);
      f.worker.verifying();
      await expect(startConnectorAfterUpdate(f.home, f.job, f.stage, f.run)).rejects.toThrow();
      expect(f.state.mutations).toEqual(['stop', 'start']);
    }
  },
);

it('refuses a connector which appeared after approval said it was absent', async () => {
  const f = fixture();
  f.job.connector = { state: 'absent' };
  await expect(stopConnectorForUpdate(f.home, f.job, f.run)).rejects.toThrow('changed');
  expect(f.state.mutations).toEqual([]);
});

it('observes a recovered connector without restarting it and refuses changed operation evidence', async () => {
  const f = fixture();
  f.worker.verifying();
  const operation = f.worker.failed('Completion reply lost');
  f.worker.release();
  f.state.observation.identity.instance = randomUUID();
  expect(await inspectReplacementConnector(f.home, f.job, operation, f.stage, f.run)).toMatchObject(
    { state: 'running' },
  );
  expect(f.state.mutations).toEqual([]);
  expect(f.store.read()).toEqual(operation);
  f.inspect.mockImplementationOnce(async () => {
    f.store.resolveRecovery(operation, 'complete', digest('another observer'));
    return { ...f.state.observation, blockers: [] };
  });
  await expect(
    inspectReplacementConnector(f.home, f.job, operation, f.stage, f.run),
  ).rejects.toThrow('changed');
  expect(f.state.mutations).toEqual([]);
});
