import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import type { CompilationCommandRunner } from '../../../../src/compilation/process.js';
import { startDaemon } from '../../../../src/daemon.js';
import { HostClaimBusy } from '../../../../src/security/claims.js';
import {
  acquireRuntimeController,
  readRuntimeController,
  readRuntimeJson,
} from '../../../../src/runtime/ownership/storage.js';
import { runtimeStateSchema } from '@puddle/shared';
import { prepareServiceReplacement } from '../../../../src/host/supervision/replacement.js';
import { inspectRunningService } from '../../../../src/host/supervision/inspection.js';
import { stopDaemonForUpdate } from '../../../../src/updates/worker/daemon/stop.js';
import { readHostUpdateCheckpoint } from '../../../../src/updates/checkpoints/store.js';
import { updateWorkerDirectory } from '../../../../src/updates/worker/supervisor.js';
import { acceptedCheckpointUpdate, checkpointWorker } from '../../../helpers/update-checkpoint.js';
import { runtimeDatabase } from '../../../helpers/runtime-database.js';
import { launchOwner, terminal, waitForOwner } from '../../../helpers/runtime-fixture.js';
import { systemdObservation } from '../../../helpers/host-supervision.js';

it('hands a drained daemon checkpoint to the worker while the independent owner keeps running', async () => {
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
    pending = stopDaemonForUpdate(f.home, job, run);
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    expect(() => readHostUpdateCheckpoint(f.home, job.operation_id)).toThrow('ENOENT');
    process.kill(pid, 0);
    release();
    handoff = await pending;
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
});
