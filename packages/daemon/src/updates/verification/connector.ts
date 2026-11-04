import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { HostStageReceipt, HostUpdateOperation, HostUpdateWorker } from '@puddle/shared';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import { HostUpdateConnector } from '../preflight/connector.js';
import { requireVerificationOperation } from './operation.js';

/** Observe a replacement without starting it. Null means it has not established readiness. */
export async function inspectReplacementConnector(
  home: string,
  job: HostUpdateWorker,
  operation: HostUpdateOperation,
  stage: HostStageReceipt,
  run?: CompilationCommandRunner,
) {
  requireVerificationOperation(home, operation, job);
  const approved = job.connector;
  if (!approved) throw new Error('Missing approved connector inventory');
  if (
    stage.record.component !== 'daemon' ||
    !operation.stages.some((item) => item.digest === stage.digest)
  )
    throw new Error('Connector verification requires the approved daemon stage');
  const observed = await new HostUpdateConnector(home, homedir(), {
    platform: job.kind === 'systemd' ? 'linux' : 'darwin',
    run,
  }).inspect(operation);
  requireVerificationOperation(home, operation, job);
  if (approved.state === 'absent') {
    if (observed.state !== 'absent' || observed.blockers.length)
      throw new Error('Unexpected connector installation after update');
    return { state: 'absent' as const };
  }
  if (
    observed.state !== 'running' ||
    !observed.identity ||
    !observed.service ||
    observed.blockers.length
  )
    return null;
  const versions = await realpath(join(home, 'bin/versions'));
  const root = await realpath(join(versions, stage.record.generation));
  requireVerificationOperation(home, operation, job);
  if (
    dirname(root) !== versions ||
    root !== join(versions, stage.record.generation) ||
    observed.identity.instance === approved.identity.instance ||
    observed.identity.release_path !== root ||
    observed.identity.version !== stage.record.version ||
    observed.service.definition_digest !== approved.service.definition_digest ||
    observed.service.name !== approved.service.name ||
    observed.service.kind !== approved.service.kind ||
    observed.service.domain !== approved.service.domain
  )
    throw new Error('Replacement connector does not match the selected generation and service');
  return { state: 'running' as const, identity: observed.identity, service: observed.service };
}
