import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import type { CompilationCommandRunner } from '../../../../src/compilation/process.js';
import { startDaemon } from '../../../../src/daemon.js';
import { acquireHostClaim, HostClaimBusy } from '../../../../src/security/claims.js';
import {
  acquireRuntimeController,
  readRuntimeController,
  readRuntimeJson,
} from '../../../../src/runtime/ownership/storage.js';
import { hostReleaseCapabilities, runtimeStateSchema } from '@puddle/shared';
import { DATABASE_SCHEMA_VERSION } from '../../../../src/db/migrations/index.js';
import { prepareServiceReplacement } from '../../../../src/host/supervision/replacement.js';
import { inspectRunningService } from '../../../../src/host/supervision/inspection.js';
import { stopDaemonForUpdate } from '../../../../src/updates/worker/daemon/stop.js';
import { HostUpdateActions } from '../../../../src/updates/worker/actions.js';
import { claimStoppedHostUpdateRecovery } from '../../../../src/updates/recovery/shutdown.js';
import { readHostUpdateCheckpoint } from '../../../../src/updates/checkpoints/store.js';
import { updateWorkerDirectory } from '../../../../src/updates/worker/supervisor.js';
import { acceptedCheckpointUpdate, checkpointWorker } from '../../../helpers/update-checkpoint.js';
import { runtimeDatabase } from '../../../helpers/runtime-database.js';
import { launchOwner, terminal, waitForOwner } from '../../../helpers/runtime-fixture.js';
import { systemdObservation } from '../../../helpers/host-supervision.js';

it.each([false, true])(
  'hands a drained daemon checkpoint to the worker while the independent owner keeps running (lost stop reply=%s)',
  async (lostReply) => {
    const f = runtimeDatabase();
    const owner = launchOwner(f.home, f.binding.runtime_id);
    await waitForOwner(owner, f.directory);
    const pid = terminal(
      runtimeStateSchema.parse(readRuntimeJson(join(f.directory, 'state.json'))),
    ).pid!;
    f.controller.release();
    const daemon = await startDaemon({ home: f.home, adapters: [], port: 0 });
    const accepted = acceptedCheckpointUpdate(f.home);
    const { id, epoch } = readRuntimeController(f.home);
    const job = checkpointWorker(f.home, accepted, { pid: process.pid, controller: { id, epoch } });
    let stopped = false;
    let stops = 0;
    const run: CompilationCommandRunner = async (command) => {
      if (command.args[1] === 'stop') {
        stops++;
        await daemon.stop();
        stopped = true;
        if (lostReply) throw new Error('Stop acknowledgement lost');
      }
      return {
        exitCode: 0,
        stderr: '',
        stdout:
          command.args[1] === 'cat'
            ? '[Service]\nRestart=always\n'
            : stopped
              ? 'Id=puddled.service\nLoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nNeedDaemonReload=no\n'
              : systemdObservation(process.pid),
      };
    };
    const target = { kind: 'systemd' as const, name: 'puddled.service', domain: null };
    job.daemon_service = await prepareServiceReplacement(
      f.home,
      await inspectRunningService(f.home, target, process.pid, run),
      { run },
    );
    atomicPrivateJson(join(updateWorkerDirectory(f.home, job.operation_id), 'worker.json'), job);
    const execution = accepted.store.claimExecution(
      accepted.operation,
      job.dispatch_id,
      job.preflight,
    );
    const actions = new HostUpdateActions(f.home, job);
    await actions.run('stop-connector', async () => {});
    const release = daemon.admission.enter();
    const drain = vi.spyOn(daemon.admission, 'drain');
    let handoff: Awaited<ReturnType<typeof stopDaemonForUpdate>> | undefined;
    let pending: Promise<Awaited<ReturnType<typeof stopDaemonForUpdate>>> | undefined;
    try {
      await expect(
        stopDaemonForUpdate(
          f.home,
          { ...job, outgoing: { ...job.outgoing!, controller: { id: randomUUID(), epoch } } },
          run,
        ),
      ).rejects.toThrow('controller changed');
      expect(stops).toBe(0);
      pending = (async () => {
        let result: Awaited<ReturnType<typeof stopDaemonForUpdate>> | undefined;
        await actions.run('stop-daemon', async () => {
          result = await stopDaemonForUpdate(f.home, job, run);
        });
        return result!;
      })();
      await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
      expect(() => readHostUpdateCheckpoint(f.home, job.operation_id)).toThrow('ENOENT');
      process.kill(pid, 0);
      release();
      if (lostReply) {
        await expect(pending).rejects.toThrow('acknowledgement lost');
        const operation = execution.failed('Stop acknowledgement lost');
        execution.release();
        const group = 2147483647;
        expect(() => process.kill(-group, 0)).toThrowError(
          expect.objectContaining({ code: 'ESRCH' }),
        );
        atomicPrivateJson(join(updateWorkerDirectory(f.home, job.operation_id), 'lifetime.json'), {
          format: 1,
          operation_id: operation.id,
          dispatch_id: operation.dispatch_id,
          worker_id: operation.worker_id,
          preflight: operation.approved,
          process_group: group,
        });
        const stage = operation.stages[0]!;
        const release = join(f.home, 'bin/versions', stage.record.generation);
        mkdirSync(release, { recursive: true, mode: 0o700 });
        atomicPrivateJson(join(release, '.puddle-stage.json'), stage.record);
        const metadata = join(release, 'HOST_CAPABILITIES.json');
        const capabilities = {
          ...hostReleaseCapabilities(stage.record.version, DATABASE_SCHEMA_VERSION),
          application: stage.record.protocol,
        };
        writeFileSync(
          metadata,
          JSON.stringify({ ...capabilities, supported_runtime_majors: [99] }),
        );
        await expect(
          claimStoppedHostUpdateRecovery(f.home, operation, () => true, run),
        ).rejects.toThrow('checkpointed runtime');
        acquireHostClaim(f.home, 'daemon-controller').release();
        process.kill(pid, 0);
        writeFileSync(metadata, JSON.stringify(capabilities));
        const recovery = await claimStoppedHostUpdateRecovery(
          f.home,
          accepted.store.read()!,
          () => true,
          run,
        );
        expect(recovery.actions.actions).toContainEqual({
          action: 'stop-daemon',
          state: 'started',
        });
        expect(() => acquireRuntimeController(f.home)).toThrow(HostClaimBusy);
        recovery.check();
        handoff = {
          checkpoint: recovery.checkpoint,
          digest: recovery.checkpointDigest,
          release: recovery.release,
        };
      } else handoff = await pending;
      expect(stops).toBe(1);
      expect(handoff.checkpoint.owners[0]?.identity.runtime_id).toBe(f.binding.runtime_id);
      expect(handoff.checkpoint.owners[0]?.state).toBe('running');
      expect(() => acquireRuntimeController(f.home)).toThrow(HostClaimBusy);
      process.kill(pid, 0);
      handoff.release();
      const replacement = await startDaemon({ home: f.home, adapters: [], port: 0 });
      try {
        expect(f.runtimes.ownerOf(f.session.id)?.runtime_id).toBe(f.binding.runtime_id);
        process.kill(pid, 0);
      } finally {
        await replacement.stop();
      }
    } finally {
      release();
      handoff?.release();
      if (pending && !handoff)
        await pending.then(
          (result) => result.release(),
          () => {},
        );
      await daemon.stop();
      execution.release();
      drain.mockRestore();
      await f.reconciler.close();
      f.db.close();
    }
  },
);
