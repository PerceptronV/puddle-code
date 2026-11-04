import { mkdirSync, realpathSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hostUpdateTerminal } from '@puddle/shared';
import { privateDirectory } from '@puddle/shared/node';
import { readHostUpdateLedger, updateWorkerExecutables } from '@puddle/shared/node/host-control';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import { acquireHostClaim } from '../../security/claims.js';
import { requireEndedUpdateWorker } from '../../updates/worker/lifetime.js';
import { readUpdateWorker } from '../../updates/worker/supervisor.js';
import { requireEndedUpdateRecoveryWorkers } from '../../updates/recovery/worker/records.js';
import { supervisorCommand } from '../services.js';
import {
  requireSelectedDaemonExecutable,
  serviceDefinitionDigest,
} from '../supervision/definition.js';
import { inspectHostServiceManager } from '../supervision/inspection.js';
import { readSupervisorMarker } from '../supervision/marker.js';
import {
  serviceHasNoProcess,
  resetServiceStartLimit,
  unloadIdleLaunchdService,
} from '../supervision/stopped.js';

/** Start the selected service once. Installation, update recovery and owner restart are separate. */
export async function startSelectedDaemon(
  home: string,
  releasePath: string,
  options: {
    platform?: NodeJS.Platform;
    uid?: number;
    definitionPath?: string;
    run?: CompilationCommandRunner;
  } = {},
): Promise<void> {
  const claims: Array<{ release(): void }> = [];
  let installationLocked = false;
  const lock = join(home, 'bin/.install-lock');
  try {
    claims.push(acquireHostClaim(home, 'host-update-coordinator'));
    claims.push(acquireHostClaim(home, 'host-update-execution'));
    const controller = acquireHostClaim(home, 'daemon-controller');
    claims.push(controller);
    privateDirectory(join(home, 'bin'));
    // Share the canonical installer's exclusion without changing any selector or definition.
    mkdirSync(lock, { mode: 0o700 });
    installationLocked = true;
    const paths = updateWorkerExecutables(home, releasePath);
    const check = () => {
      if (realpathSync(join(home, 'bin/current')) !== paths.release_path)
        throw new Error('Selected daemon changed before startup');
      const { current } = readHostUpdateLedger(home);
      if (current?.dispatch_id && !hostUpdateTerminal(current.phase))
        throw new Error('An interrupted host activation requires explicit recovery');
      if (current?.worker_id) {
        requireEndedUpdateWorker(home, readUpdateWorker(home, current.id), current);
        requireEndedUpdateRecoveryWorkers(home, current);
      }
    };
    check();
    const manager = await inspectHostServiceManager(home, options);
    if ((await readSupervisorMarker(home, options.uid ?? process.getuid!())) !== manager.kind)
      throw new Error('Unknown installed daemon supervision');
    const target = {
      ...manager,
      name: manager.kind === 'systemd' ? 'puddled.service' : 'dev.puddle.puddled',
    };
    const definitionPath =
      manager.kind === 'launchd'
        ? (options.definitionPath ??
          join(homedir(), 'Library/LaunchAgents/dev.puddle.puddled.plist'))
        : null;
    const definition = await serviceDefinitionDigest(home, target, definitionPath, options.run);
    if (!(await serviceHasNoProcess(home, target, options.run)))
      throw new Error('Installed daemon service is not positively stopped');
    const requireCurrent = async () => {
      if ((await serviceDefinitionDigest(home, target, definitionPath, options.run)) !== definition)
        throw new Error('Daemon service configuration changed before startup');
      await requireSelectedDaemonExecutable(home, target, options.run);
      check();
    };
    await requireCurrent();
    await unloadIdleLaunchdService(home, target, requireCurrent, options.run);
    await resetServiceStartLimit(home, target, requireCurrent, options.run);
    await requireCurrent();
    // Startup will acquire the same controller claim. Keep update/installer exclusion
    // through dispatch, but do not mint an epoch or rewrite the previous controller record.
    controller.release();
    const execute = supervisorCommand(home, options.run);
    if (target.kind === 'systemd') await execute('systemctl', ['--user', 'start', target.name]);
    else await execute('/bin/launchctl', ['bootstrap', target.domain!, definitionPath!]);
  } finally {
    try {
      if (installationLocked) rmdirSync(lock);
    } finally {
      for (const claim of claims.reverse()) claim.release();
    }
  }
}
