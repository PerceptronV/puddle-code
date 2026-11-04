import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inspectHostRemoval, updateWorkerExecutables } from '@puddle/shared/node/host-control';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import { supervisorCommand } from '../services.js';
import { HostRemovalGuard } from './guard.js';

/** Invoke only the selected packaged connector, with no configuration or credentials in replies. */
export async function removalRemoteAccess(
  guard: HostRemovalGuard,
  action: 'disable' | 'verify' | { removalId: string },
  authorised: () => boolean,
  run?: CompilationCommandRunner,
): Promise<void> {
  guard.requireHeld();
  if (!authorised()) throw new Error('Host removal authority expired');
  const paths = updateWorkerExecutables(guard.home, realpathSync(join(guard.home, 'bin/current')));
  const entry = join(paths.release_path, 'daemon/connector.mjs');
  if (realpathSync(entry) !== entry || !statSync(entry).isFile())
    throw new Error('Connector helper is not pinned to the selected release');
  const guarded = guard.commands(run);
  let args: string[];
  if (typeof action !== 'string') {
    const removal = inspectHostRemoval(guard.home);
    if (removal.state !== 'removing' || removal.id !== action.removalId)
      throw new Error('No matching active removal to continue');
    args = ['--continue-removal-disable', action.removalId];
  } else args = [action === 'disable' ? '--disable-all' : '--verify-disabled'];
  await supervisorCommand(guard.home, (command) =>
    guarded({
      ...command,
      env: { ...process.env, PUDDLE_HOME: guard.home },
    }),
  )(paths.node_path, [entry, ...args]);
  guard.requireHeld();
  if (!authorised()) throw new Error('Host removal authority expired');
}
