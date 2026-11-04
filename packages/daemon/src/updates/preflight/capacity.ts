import { join } from 'node:path';
import {
  hostUpdateOperationSchema,
  type HostUpdateOperation,
  type StorageStatus,
} from '@puddle/shared';
import type { PuddlePaths } from '../../paths.js';
import type { StorageMonitor } from '../../storage/monitor.js';

export interface UpdateCapacity {
  volumes: StorageStatus['volumes'];
  blockers: Array<{
    code: 'storage_full' | 'storage_unavailable' | 'state_not_saved';
    target: string;
  }>;
}

/** Headroom after staging, not a reservation or a migration-size guarantee. */
export class HostUpdateCapacity {
  constructor(
    private readonly paths: Pick<PuddlePaths, 'home' | 'dbFile'>,
    private readonly storage: Pick<StorageMonitor, 'inspectPaths' | 'status'>,
  ) {}

  async inspect(input: HostUpdateOperation): Promise<UpdateCapacity> {
    const operation = hostUpdateOperationSchema.parse(input);
    if (operation.stages.length !== operation.targets.length)
      throw new Error('Host update is not completely staged');
    const replacesDaemon = operation.targets.some((target) => target.component === 'daemon');
    const paths = [join(this.paths.home, 'bin'), join(this.paths.home, 'updates')];
    if (replacesDaemon) paths.push(this.paths.dbFile);
    const volumes = await this.storage.inspectPaths(paths);
    const blockers: UpdateCapacity['blockers'] = [];
    for (const path of new Set(paths)) {
      const volume = volumes.find((item) => item.path === path);
      if (!volume || volume.level === 'unknown')
        blockers.push({ code: 'storage_unavailable', target: path });
      else if (volume.level === 'critical') blockers.push({ code: 'storage_full', target: path });
    }
    // Recheck after async probes: PTYs keep running and persistence can degrade
    // while storage inspection is in flight. Never discard queued observations.
    const status = this.storage.status();
    if (status.database_degraded) blockers.push({ code: 'state_not_saved', target: 'database' });
    if (replacesDaemon && status.logs_degraded)
      blockers.push({ code: 'state_not_saved', target: 'terminal_history' });
    return { volumes, blockers };
  }
}
