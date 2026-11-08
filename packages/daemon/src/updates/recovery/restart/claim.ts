import { digest } from '@puddle/shared/node';
import type { CompilationCommandRunner } from '../../../compilation/process.js';
import { requireUnchangedServiceDefinition } from '../../../host/supervision/replacement.js';
import { serviceHasNoProcess } from '../../../host/supervision/stopped.js';
import { readRuntimeController } from '../../../runtime/ownership/storage.js';
import { resolveInstalledRuntimeRelease } from '../../../runtime/lifecycle/release.js';
import { acquireHostClaim } from '../../../security/claims.js';
import {
  readStageCapabilities,
  readStageDaemonRuntimeCapabilities,
} from '@puddle/shared/node/host-control';
import { readDaemonUpdateCheckpoint } from '../../verification/shutdown.js';
import { verifyUpdateSelection } from '../../worker/selection.js';
import type { claimHostUpdateRecovery } from '../claim.js';
import { readRecoveryActions } from '../actions.js';
import { inspectRecoveryDatabase } from './database.js';

/** A new explicit start after confirmed loss, never inference from a failed adoption request. */
export async function retainEndedUpdateRecovery(
  home: string,
  recovery: Pick<
    ReturnType<typeof claimHostUpdateRecovery>,
    'operation' | 'job' | 'check' | 'release' | 'releaseExecution'
  >,
  run?: CompilationCommandRunner,
) {
  const claim = acquireHostClaim(home, 'daemon-controller');
  let released = false;
  let controllerReleased = false;
  const releaseController = () => {
    if (controllerReleased) return;
    controllerReleased = true;
    claim.release();
  };
  const release = () => {
    if (released) return;
    released = true;
    try {
      releaseController();
    } finally {
      recovery.release();
    }
  };
  try {
    const { operation, job } = recovery;
    const controller = readRuntimeController(home);
    const check = () => {
      if (released || controllerReleased) throw new Error('Ended recovery claim is released');
      recovery.check();
      if (JSON.stringify(readRuntimeController(home)) !== JSON.stringify(controller))
        throw new Error('Recovery controller changed');
      operation.stages.forEach((stage) => verifyUpdateSelection(home, stage));
    };
    const inspect = async () => {
      check();
      if (!job.daemon_service) throw new Error('Missing daemon service');
      await requireUnchangedServiceDefinition(home, job.daemon_service, run);
      if (!(await serviceHasNoProcess(home, job.daemon_service, run)))
        throw new Error('Replacement daemon has not ended');
      check();
      const evidence = readDaemonUpdateCheckpoint(home, job);
      const previous = evidence.checkpoint.daemon.controller;
      if (
        controller.epoch < previous.epoch ||
        (controller.epoch === previous.epoch) !== (controller.id === previous.id)
      )
        throw new Error('Recovery controller does not follow the shutdown checkpoint');
      const stage = operation.stages.find(({ record }) => record.component === 'daemon');
      if (!stage) throw new Error('Missing daemon recovery stage');
      const candidate = await readStageCapabilities(home, stage);
      const roles = await readStageDaemonRuntimeCapabilities(home, stage);
      const runtime = resolveInstalledRuntimeRelease(home);
      if (!candidate.supported_runtime_majors.includes(runtime.protocol.major))
        throw new Error('Candidate cannot launch the installed runtime');
      const database = await inspectRecoveryDatabase(home, candidate, evidence.checkpoint, roles);
      check();
      if (!(await serviceHasNoProcess(home, job.daemon_service, run)))
        throw new Error('Replacement daemon changed during recovery');
      check();
      const fingerprint = digest(
        JSON.stringify({
          controller,
          checkpoint: evidence.digest,
          candidate,
          roles,
          runtime,
          database,
          selected: operation.stages.map((stage) => verifyUpdateSelection(home, stage)),
        }),
      );
      return { fingerprint, database_schema_version: database.schema, owners: database.owners };
    };
    const restart = await inspect();
    return {
      ...recovery,
      actions: readRecoveryActions(home, job, operation),
      mode: 'restart' as const,
      restart,
      check,
      releaseController,
      release,
      beforeStart: async () => {
        if (JSON.stringify(await inspect()) !== JSON.stringify(restart))
          throw new Error('Daemon restart evidence changed');
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
