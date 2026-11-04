import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { onTestFinished, vi } from 'vitest';
import {
  hostConnectorReplacementSchema,
  hostUpdateActionsSchema,
  type HostUpdateAdoption,
} from '@puddle/shared';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import { acquireRuntimeController } from '../../src/runtime/ownership/storage.js';
import { writeRuntime } from '../../src/runtime-file.js';
import { resolvePaths } from '../../src/paths.js';
import { HostUpdateConnector } from '../../src/updates/preflight/connector.js';
import * as adoptionVerification from '../../src/updates/verification/adoption.js';
import * as lifetime from '../../src/updates/worker/lifetime.js';
import { recoveryWorkerFixture } from './update-recovery.js';
import { systemdObservation } from './host-supervision.js';
import { DATABASE_SCHEMA_VERSION } from '../../src/db/migrations/index.js';

/** Real records/claims/service validation; daemon authority and supervisor processes are fixtures. */
export async function runningRecoveryFixture(
  start: 'started' | 'finished' = 'started',
  connector = false,
) {
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
  const state = {
    connectorRunning: false,
    serviceRunning: false,
    failed: false,
    limited: false,
    definition: 'connector fixture',
    loseStartReply: false,
    loseResetReply: false,
    afterReset: () => {},
    afterStart: () => {},
    changes: [] as string[],
  };
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
    if (action === 'cat') stdout = state.definition;
    else if (action === 'show') {
      stdout =
        state.connectorRunning || state.serviceRunning
          ? systemdObservation(2147483647, approved.service.name)
          : `Id=${approved.service.name}\nLoadState=loaded\nActiveState=${state.failed ? 'failed' : 'inactive'}\nSubState=${state.failed ? 'failed' : 'dead'}\nMainPID=0\nNeedDaemonReload=no\n`;
      if (command.args.some((arg) => arg.includes(',Result')))
        stdout += `Result=${state.limited ? 'start-limit-hit' : state.failed ? 'exit-code' : 'success'}\n`;
    } else if (action === 'reset-failed') {
      state.changes.push('reset-connector');
      state.failed = false;
      state.limited = false;
      state.afterReset();
      if (state.loseResetReply) throw new Error('Connector reset reply lost');
    } else if (action === 'start') {
      state.changes.push('start-connector');
      state.connectorRunning = true;
      state.afterStart();
      if (state.loseStartReply) throw new Error('Connector start reply lost');
    } else throw new Error('Unexpected component mutation');
    return { exitCode: 0, stdout, stderr: '' };
  };
  const options = {
    ...f.options,
    run: async (command: Parameters<typeof run>[0]) =>
      ['cat', 'show'].includes(command.args[1]!) ? run(command) : f.supervisor(command),
  };
  return { ...f, actions, controller, verify, running: state, run, replacement, options };
}
