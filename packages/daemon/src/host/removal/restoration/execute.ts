import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { hostRemovalServicesSchema, hostRemovalRestoreSchema } from '@puddle/shared';
import { readPrivateJson } from '@puddle/shared/node';
import { inspectHostRemoval } from '@puddle/shared/node/host-control';
import type { CompilationCommandRunner } from '../../../compilation/process.js';
import { HostRemovalGuard } from '../guard.js';
import { HostRemovalServiceOperation } from '../operations/services.js';
import { HostRemovalServiceRestore } from './services.js';
import { preparePurgedRestoration } from './purge.js';

/** One explicit configuration attempt; the caller observes hand-off before ordinary startup. */
export async function restoreRemovedHostServices(
  home: string,
  release: string,
  id: string,
  options: {
    authorised: () => boolean;
    resume: boolean;
    run?: CompilationCommandRunner;
    userHome?: string;
    bootIdentity?: () => Promise<string | null>;
  },
): Promise<void> {
  hostRemovalServicesSchema.shape.id.parse(id);
  const guard = HostRemovalGuard.acquire(home);
  let controller: ReturnType<HostRemovalGuard['acquireController']> | undefined;
  try {
    if (realpathSync(join(home, 'bin/current')) !== release)
      throw new Error('Service restoration must use the selected release');
    controller = guard.acquireController();
    const status = inspectHostRemoval(home);
    if (status.state === 'restored' && status.id === id)
      throw new Error('Service restoration was already handed off');
    if (options.resume) {
      const previous = hostRemovalRestoreSchema.parse(
        readPrivateJson(join(home, 'installation/removal/restore.json'), 4096),
      );
      if (previous.removal_id !== id)
        throw new Error('Missing exact restoration journal for continuation');
    }
    const purge = await preparePurgedRestoration(
      guard,
      id,
      options.authorised,
      options.bootIdentity,
    );
    const operation = HostRemovalServiceOperation.open(guard, options);
    if (operation.read().id !== id) throw new Error('The reviewed removal changed');
    const restoration = new HostRemovalServiceRestore(guard, operation, { ...options, purge });
    await restoration.restore();
    await restoration.handoff();
  } finally {
    try {
      controller?.release();
    } finally {
      guard.release();
    }
  }
}
