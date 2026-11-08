import type { RuntimeLaunch, RuntimeSupervisor } from '@puddle/shared';
import { readHostBootIdentity } from '@puddle/shared/node/host-control';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import { inspectHostServiceManager } from '../../host/supervision/inspection.js';
import { readSupervisorMarker } from '../../host/supervision/marker.js';
import { requireIndependentProcessGroup } from './process.js';

/** A missing manager is not permission to fall back after a supervised launch attempt. */
export async function selectRuntimeSupervisor(
  home: string,
  run?: CompilationCommandRunner,
): Promise<RuntimeSupervisor['kind']> {
  try {
    return (await inspectHostServiceManager(home, { run })).kind;
  } catch (error) {
    const uid = process.getuid?.();
    if (uid === undefined || !['linux', 'darwin'].includes(process.platform)) throw error;
    const marker = await readSupervisorMarker(home, uid);
    if (marker !== 'nohup' && marker !== 'none') throw error;
    return 'detached';
  }
}

/** Validate before consuming launch intent or starting any provider/PTY. */
export async function prepareRuntimeLifetime(
  home: string,
  launch: Pick<RuntimeLaunch, 'boot_id' | 'lifetime'>,
): Promise<() => void> {
  if (launch.boot_id !== undefined && launch.boot_id !== (await readHostBootIdentity()))
    throw new Error('Runtime launch belongs to another or unverified host boot');
  if (launch.lifetime !== 'host_session') return () => {};
  if (!launch.boot_id) throw new Error('Detached runtime requires a verified host boot');
  // Ignore terminal hangup before the asynchronous group inspection; explicit
  // runtime stop still uses its authenticated controller and SIGTERM/SIGINT.
  const hangup = () => {};
  process.on('SIGHUP', hangup);
  const release = () => {
    process.off('SIGHUP', hangup);
  };
  try {
    await requireIndependentProcessGroup(home);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
