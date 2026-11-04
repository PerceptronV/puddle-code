import type { CompilationCommandRunner } from '../../compilation/process.js';
import { supervisorCommand } from '../services.js';
import { serviceIsStopped } from './stopped.js';
import { inspectSystemdProperties, systemdServiceProperties } from './systemd.js';
import { validServiceTarget, type ServiceTarget } from './target.js';

/** Stronger than stopped: no registered job/unit remains. Retained source files stay intact. */
export async function serviceIsRemoved(
  home: string,
  target: ServiceTarget,
  run?: CompilationCommandRunner,
): Promise<boolean> {
  validServiceTarget(target);
  if (target.kind === 'launchd') return serviceIsStopped(home, target, run);
  // A missing user manager must never be mistaken for an absent unit.
  await supervisorCommand(home, run)('systemctl', ['--user', 'show-environment']);
  const values = await inspectSystemdProperties(home, target, systemdServiceProperties, run, true);
  const expected = new Map([
    ['Id', target.name],
    ['LoadState', 'not-found'],
    ['ActiveState', 'inactive'],
    ['SubState', 'dead'],
    ['MainPID', '0'],
    ['NeedDaemonReload', 'no'],
  ]);
  return values !== null && [...expected].every(([key, value]) => values.get(key) === value);
}
