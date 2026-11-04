import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type HostUpdateAdoption } from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import {
  runCompilationCommand,
  type CompilationCommandRunner,
} from '../../../../src/compilation/process.js';
import { openDatabase } from '../../../../src/db/db.js';
import { RuntimeStore } from '../../../../src/db/stores/runtimes.js';
import { acquireRuntimeController } from '../../../../src/runtime/ownership/storage.js';
import { HostClaimBusy } from '../../../../src/security/claims.js';
import { prepareServiceReplacement } from '../../../../src/host/supervision/replacement.js';
import { inspectRunningService } from '../../../../src/host/supervision/inspection.js';
import { HostUpdateCheckpointWriter } from '../../../../src/updates/checkpoints/store.js';
import { HostUpdateConnector } from '../../../../src/updates/preflight/connector.js';
import { executeHostUpdate } from '../../../../src/updates/worker/execute.js';
import * as connectorReplacement from '../../../../src/updates/worker/connector.js';
import * as adoptionVerification from '../../../../src/updates/worker/verify-adoption.js';
import { updateInstallation } from '../../../helpers/update-installation.js';
import { systemdObservation } from '../../../helpers/host-supervision.js';

afterEach(() => vi.restoreAllMocks());

async function fixture(combined = false, connector = false) {
  const f = await updateInstallation(combined ? ['daemon', 'runtime'] : ['daemon']);
  f.job.connector = { state: 'absent' };
  vi.spyOn(HostUpdateConnector.prototype, 'inspect').mockResolvedValue({
    state: 'absent',
    identity: null,
    blockers: [],
  });
  const db = openDatabase(join(f.puddleHome, 'puddle.db'));
  let controller = acquireRuntimeController(f.puddleHome);
  const { id, epoch } = controller.record;
  f.job.outgoing = { pid: process.pid, controller: { id, epoch } };
  const state = {
    stopped: false,
    fail: '',
    changes: [] as string[],
    definition: 'existing custom service configuration',
  };
  if (connector) {
    // Service/IPC behaviour has a separate connector suite. Here verify transaction ordering and recovery.
    vi.spyOn(connectorReplacement, 'stopConnectorForUpdate').mockImplementation(async () => {
      state.changes.push('stop-connector');
      if (state.fail === 'stop-connector') throw new Error('Connector stop reply lost');
    });
    vi.spyOn(connectorReplacement, 'startConnectorAfterUpdate').mockImplementation(async () => {
      state.changes.push('start-connector');
      if (state.fail === 'start-connector') throw new Error('Connector start reply lost');
      return { state: 'absent' };
    });
  }
  const reference = {
    operation_id: f.operation.id,
    dispatch_id: f.job.dispatch_id,
    preflight: f.job.preflight,
  };
  const run: CompilationCommandRunner = async (command) => {
    if (command.file === '/bin/sh') {
      expect(() => acquireRuntimeController(f.puddleHome)).toThrow(HostClaimBusy);
      state.changes.push(`select-${command.args[command.args.indexOf('--component') + 1]}`);
      const result = await runCompilationCommand(command);
      if (state.fail === 'select') throw new Error('Selection reply lost');
      if (state.fail === 'configuration') state.definition = 'changed after selection';
      return result;
    }
    let stdout = '';
    if (command.args[1] === 'cat') stdout = state.definition;
    else if (command.args[1] === 'show')
      stdout = state.stopped
        ? 'Id=puddled.service\nLoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nNeedDaemonReload=no\n'
        : systemdObservation(process.pid);
    else if (command.args[1] === 'stop') {
      state.changes.push('stop');
      new HostUpdateCheckpointWriter(
        { home: f.puddleHome, db, runtimes: new RuntimeStore(db), version: 'old' },
        reference,
      ).commit(controller.record);
      controller.release();
      state.stopped = true;
      if (state.fail === 'stop') throw new Error('Stop reply lost');
    } else if (command.args[1] === 'start') {
      state.changes.push('start');
      expect(f.store.read()?.phase).toBe('verifying');
      controller = acquireRuntimeController(f.puddleHome);
      state.stopped = false;
      if (state.fail === 'start') throw new Error('Start reply lost');
    } else throw new Error('Unexpected supervisor command');
    return { exitCode: 0, stdout, stderr: '' };
  };
  const target = { kind: 'systemd' as const, name: 'puddled.service', domain: null };
  f.job.daemon_service = await prepareServiceReplacement(
    f.puddleHome,
    await inspectRunningService(f.puddleHome, target, process.pid, run),
    { run },
  );
  // This suite checks transaction composition with the real installer/checkpoint/claims.
  // Authority and live owner proof are exercised separately by adoption.test.ts.
  const verify = vi
    .spyOn(adoptionVerification, 'verifyHostUpdateAdoption')
    .mockImplementation(async (_home, operation) => {
      expect(operation.phase).toBe('verifying');
      expect(state.changes.at(-1)).toBe(connector ? 'start-connector' : 'start');
      state.changes.push('verify');
      const release = f.selected('daemon');
      const result: HostUpdateAdoption = {
        ...reference,
        format: 1,
        nonce: randomUUID(),
        checkpoint: digest('verified checkpoint'),
        stage: f.receipts[0]!.digest,
        observed_at: Date.now(),
        owners: [],
        daemon: {
          pid: process.pid,
          port: 7434,
          version: '1.2.3',
          protocol: PROTOCOL_VERSION,
          schema_version: 1,
          controller: { id: controller.record.id, epoch: controller.record.epoch },
          release_path: release,
          node_path: join(release, 'bin/node'),
          entry_path: join(release, 'daemon/puddled.mjs'),
        },
      };
      return result;
    });
  return {
    ...f,
    run,
    state,
    verify,
    close() {
      controller.release();
      db.close();
    },
  };
}

it.each([false, true])(
  'executes a daemon update (combined=%s) in stop/select/start/verify order',
  async (combined) => {
    const f = await fixture(combined);
    try {
      await executeHostUpdate(f.puddleHome, f.job, f.run);
      expect(f.state.changes).toEqual(
        combined
          ? ['stop', 'select-daemon', 'select-runtime', 'start', 'verify']
          : ['stop', 'select-daemon', 'start', 'verify'],
      );
      expect(f.store.read()?.phase).toBe('complete');
      expect(f.selected('daemon')).toBe(
        join(f.puddleHome, 'bin/versions', f.receipts[0]!.record.generation),
      );
      await expect(executeHostUpdate(f.puddleHome, f.job, f.run)).rejects.toThrow();
      expect(f.state.changes.filter((action) => action === 'stop')).toHaveLength(1);
    } finally {
      f.close();
    }
  },
  30_000,
);

it.each(['stop', 'select', 'start', 'configuration'])(
  'retains uncertainty after %s failure without rollback or replay',
  async (failure) => {
    const f = await fixture();
    try {
      f.state.fail = failure;
      await expect(executeHostUpdate(f.puddleHome, f.job, f.run)).rejects.toThrow();
      expect(f.store.read()?.phase).toBe('recovery_required');
      expect(f.verify).not.toHaveBeenCalled();
      const changes = [...f.state.changes];
      await expect(executeHostUpdate(f.puddleHome, f.job, f.run)).rejects.toThrow();
      expect(f.state.changes).toEqual(changes);
      expect(f.selected('daemon')).toBe(
        failure === 'stop'
          ? f.previousDaemon
          : join(f.puddleHome, 'bin/versions', f.receipts[0]!.record.generation),
      );
    } finally {
      f.close();
    }
  },
  30_000,
);

it.each(['', 'stop-connector', 'start-connector'])(
  'includes connector replacement in the consumed transaction (failure=%s)',
  async (failure) => {
    const f = await fixture(false, true);
    try {
      f.state.fail = failure;
      if (!failure) {
        await executeHostUpdate(f.puddleHome, f.job, f.run);
        expect(f.state.changes).toEqual([
          'stop-connector',
          'stop',
          'select-daemon',
          'start',
          'start-connector',
          'verify',
        ]);
        expect(f.store.read()?.phase).toBe('complete');
      } else {
        await expect(executeHostUpdate(f.puddleHome, f.job, f.run)).rejects.toThrow();
        expect(f.store.read()?.phase).toBe('recovery_required');
        if (failure === 'stop-connector') expect(f.state.changes).toEqual(['stop-connector']);
      }
      const mutations = [...f.state.changes];
      await expect(executeHostUpdate(f.puddleHome, f.job, f.run)).rejects.toThrow();
      expect(f.state.changes).toEqual(mutations);
    } finally {
      f.close();
    }
  },
  30_000,
);
