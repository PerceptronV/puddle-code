import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeLaunchSchema } from '@puddle/shared';
import { privatePath, syncPrivateDirectory } from '@puddle/shared/node';
import { openDatabase } from '../../../db/db.js';
import { requireOwnedDatabase } from '../../../db/paths.js';
import { RuntimeStore } from '../../../db/stores/runtimes.js';
import { readRuntimeJson } from '../../../runtime/ownership/storage.js';
import { huddleBindingLaunch } from '../../../runtime/huddle/ownership/binding.js';
import { huddleRetirementState } from '../../../runtime/huddle/ownership/retirement.js';
import { runtimeBindingIdentity } from '../../../runtime/transport/connections.js';
import { removeRuntimeService } from '../../../runtime/lifecycle/supervisor.js';
import type { CompilationCommandRunner } from '../../../compilation/process.js';
import type { HostRemovalGuard } from '../guard.js';
import { purgeDirectoryNames } from './worktrees.js';

/** Fence every delayed owner/dispatcher before recording a cross-boot purge barrier. */
export async function retirePurgeRuntimes(
  guard: HostRemovalGuard,
  requireCurrent: () => void,
  run?: CompilationCommandRunner,
): Promise<void> {
  guard.requireController();
  const deadline = Date.now() + 30_000;
  const file = join(guard.home, 'puddle.db');
  requireOwnedDatabase(file);
  const db = openDatabase(file, { migrate: false });
  try {
    const runtimes = new RuntimeStore(db);
    if (runtimes.live(1).length) throw new Error('Stop all runtimes explicitly before purge');
    const ids: string[] = [];
    for (;;) {
      const page = runtimes.releaseReferences(ids.at(-1) ?? '', 128);
      if (!page.length) break;
      ids.push(...page.map((row) => row.runtime_id));
      if (ids.length > 1024) throw new Error('Purge runtime inventory exceeds its limit');
    }
    let names: string[] = [];
    const root = join(guard.home, 'runtimes');
    try {
      privatePath(root, true);
      names = purgeDirectoryNames(root, 1024);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (JSON.stringify(ids) !== JSON.stringify(names))
      throw new Error('Unknown or missing runtime records block purge');
    for (const id of ids) {
      requireCurrent();
      if (Date.now() >= deadline) throw new Error('Purge runtime retirement exceeded its deadline');
      const directory = join(root, id);
      privatePath(directory, true);
      if (lstatSync(directory).isSymbolicLink()) throw new Error('Linked runtime blocks purge');
      const owner = runtimes.get(id)!;
      const launch =
        owner.role === 'huddle'
          ? huddleBindingLaunch(guard.home, owner)
          : runtimeLaunchSchema.parse(readRuntimeJson(join(directory, 'launch.json')));
      if (owner.role === 'huddle') {
        const read = (name: string) => {
          try {
            return readRuntimeJson(join(directory, name));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
          }
        };
        if (
          owner.state !== 'exited' ||
          !huddleRetirementState(
            owner,
            huddleBindingLaunch(guard.home, owner),
            read('huddle-owner.json'),
            read('consumed.json'),
          ).clean
        )
          throw new Error('Huddle shutdown is unresolved before purge');
      }
      if (JSON.stringify(launch.identity) !== JSON.stringify(runtimeBindingIdentity(owner)))
        throw new Error('Runtime launch identity changed before purge');
      if (
        (await removeRuntimeService(guard.home, launch.identity, guard.commands(run))) === 'owned'
      )
        throw new Error('Runtime ownership remains live before purge');
      // The boot barrier must never outlive an unflushed delayed-launch fence.
      syncPrivateDirectory(directory);
      requireCurrent();
    }
    if (ids.length) syncPrivateDirectory(root);
  } finally {
    db.close();
  }
}
