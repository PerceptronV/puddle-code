import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { hostRemovalServicesSchema } from '@puddle/shared';
import type { CompilationCommandRunner } from '../../../compilation/process.js';
import { HostRemovalGuard } from '../guard.js';
import { HostRemovalServiceOperation } from '../operations/services.js';
import { HostRemovalServiceRestore } from './services.js';

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
  },
): Promise<void> {
  hostRemovalServicesSchema.shape.id.parse(id);
  const guard = HostRemovalGuard.acquire(home);
  let controller: ReturnType<HostRemovalGuard['acquireController']> | undefined;
  try {
    if (realpathSync(join(home, 'bin/current')) !== release)
      throw new Error('Service restoration must use the selected release');
    controller = guard.acquireController();
    const operation = HostRemovalServiceOperation.open(guard, options);
    if (operation.read().id !== id) throw new Error('The reviewed removal changed');
    const restoration = new HostRemovalServiceRestore(guard, operation, options);
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
