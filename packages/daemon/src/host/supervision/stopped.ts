import {
  CompilationCommandError,
  type CompilationCommandRunner,
} from '../../compilation/process.js';
import { supervisorCommand } from '../services.js';
import { validServiceTarget, type ServiceTarget } from './inspection.js';

/** Explicit startup only. Reset this unit's rate limit, never all failed services. */
export async function resetServiceStartLimit(
  home: string,
  target: ServiceTarget,
  requireCurrent: () => Promise<void>,
  run?: CompilationCommandRunner,
): Promise<void> {
  validServiceTarget(target);
  if (target.kind !== 'systemd') return;
  const execute = supervisorCommand(home, run);
  // Ask for all admission evidence together, without interpreting status diagnostics.
  // reset-failed clears Result and the start/restart counters; it does not start a unit.
  // https://www.freedesktop.org/software/systemd/man/latest/systemctl.html#reset-failed%20%5BPATTERN%E2%80%A6%5D
  const inspect = async () => {
    const observed = await inspectSystemdStopped(home, target, run, true);
    if (!observed) throw new Error('Systemd service is not positively stopped before startup');
    return observed;
  };
  const before = await inspect();
  if (before.result !== 'start-limit-hit') return;
  await requireCurrent();
  const current = await inspect();
  if (current.failed !== before.failed || current.result !== before.result)
    throw new Error('Systemd start-limit evidence changed');
  await execute('systemctl', ['--user', 'reset-failed', target.name]);
  // A failed/lost reset reply exits above. Never infer permission to start from it.
  await requireCurrent();
  const after = await inspect();
  if (after.failed || after.result !== 'success')
    throw new Error('Systemd start-limit reset is unconfirmed');
}

/** A stopped supervisor must not be able to restart the outgoing process automatically. */
export async function serviceIsStopped(
  home: string,
  target: ServiceTarget,
  run?: CompilationCommandRunner,
  allowFailed = false,
): Promise<boolean> {
  validServiceTarget(target);
  const execute = supervisorCommand(home, run);
  if (target.kind === 'systemd') {
    const observed = await inspectSystemdStopped(home, target, run);
    return observed !== null && (allowFailed || !observed.failed);
  }
  // Confirm the domain is available; a missing manager is not proof of job removal.
  await execute('/bin/launchctl', ['print-disabled', target.domain!]);
  try {
    await execute('/bin/launchctl', ['print', `${target.domain}/${target.name}`]);
    return false;
  } catch (error) {
    if (error instanceof CompilationCommandError && error.result?.exitCode === 113) return true;
    throw error;
  }
}

/** Strict bounded properties, shared by stop proof and explicit startup recovery. */
async function inspectSystemdStopped(
  home: string,
  target: ServiceTarget,
  run?: CompilationCommandRunner,
  includeResult = false,
) {
  const properties =
    'Id,LoadState,ActiveState,SubState,MainPID,NeedDaemonReload' + (includeResult ? ',Result' : '');
  const response = await supervisorCommand(home, run)('systemctl', [
    '--user',
    'show',
    `--property=${properties}`,
    target.name,
  ]);
  const values = new Map<string, string>();
  for (const line of response.stdout.trim().split('\n')) {
    const equal = line.indexOf('=');
    const key = line.slice(0, equal);
    if (equal < 1 || values.has(key)) return null;
    values.set(key, line.slice(equal + 1));
  }
  const failed = values.get('ActiveState') === 'failed';
  const expected = new Map([
    ['Id', target.name],
    ['LoadState', 'loaded'],
    ['ActiveState', failed ? 'failed' : 'inactive'],
    ['SubState', failed ? 'failed' : 'dead'],
    ['MainPID', '0'],
    ['NeedDaemonReload', 'no'],
  ]);
  const result = values.get('Result') ?? '';
  if (
    values.size !== expected.size + Number(includeResult) ||
    [...expected].some(([key, value]) => values.get(key) !== value) ||
    (includeResult && !/^[a-z][a-z-]{0,63}$/.test(result))
  )
    return null;
  return { failed, result };
}
