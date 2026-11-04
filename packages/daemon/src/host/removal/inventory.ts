import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HostRemovalServiceReview } from '@puddle/shared';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import { readRuntime } from '../../runtime-file.js';
import { resolvePaths } from '../../paths.js';
import { inspectConnectorManager } from '../../updates/preflight/connector.js';
import { inspectHostServiceManager } from '../supervision/inspection.js';
import { serviceIsRemoved } from '../supervision/removed.js';
import { serviceHasNoProcess } from '../supervision/stopped.js';
import { readSupervisorMarker } from '../supervision/marker.js';
import { HostRemovalGuard } from './guard.js';
import { reviewRemovalService } from './services.js';

export interface RemovalInventoryOptions {
  platform?: NodeJS.Platform;
  userHome?: string;
  run?: CompilationCommandRunner;
}

export async function reviewInstalledRemovalServices(
  guard: HostRemovalGuard,
  options: RemovalInventoryOptions = {},
): Promise<HostRemovalServiceReview[]> {
  const run = guard.commands(options.run);
  const manager = await inspectHostServiceManager(guard.home, { ...options, run });
  if ((await readSupervisorMarker(guard.home, process.getuid!())) !== manager.kind)
    throw new Error('Unknown installed host supervision');
  const reviews: HostRemovalServiceReview[] = [];
  for (const component of ['connector', 'daemon'] as const) {
    const name =
      manager.kind === 'systemd'
        ? component === 'daemon'
          ? 'puddled.service'
          : 'puddle-connector.service'
        : component === 'daemon'
          ? 'dev.puddle.puddled'
          : 'dev.puddle.connector';
    const target = { ...manager, name };
    const definition =
      manager.kind === 'systemd'
        ? join(options.userHome ?? homedir(), '.config/systemd/user', name)
        : join(options.userHome ?? homedir(), 'Library/LaunchAgents', `${name}.plist`);
    let absent = false;
    try {
      lstatSync(definition);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      absent = true;
    }
    if (component === 'connector' && absent) {
      if (
        !(await serviceIsRemoved(guard.home, target, run)) ||
        (await inspectConnectorManager(guard.home))
      )
        throw new Error('Connector absence is unconfirmed');
      continue;
    }
    const stopped = await serviceHasNoProcess(guard.home, target, run);
    const pid = stopped
      ? null
      : component === 'daemon'
        ? readRuntime(resolvePaths(guard.home))?.pid
        : (await inspectConnectorManager(guard.home))?.pid;
    if (pid === undefined) throw new Error('Running service identity is unavailable');
    reviews.push(await reviewRemovalService(guard, target, component, pid, options));
  }
  guard.requireHeld();
  return reviews;
}
