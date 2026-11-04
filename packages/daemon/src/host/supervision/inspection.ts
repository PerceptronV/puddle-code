import { validServiceTarget, type ServiceTarget } from './target.js';
import { inspectLaunchdProcess } from './launchd.js';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import { supervisorCommand } from '../services.js';

export interface ServiceObservation extends ServiceTarget {
  pid: number;
  invocation: string | null;
  controlGroup: string | null;
}

/** Select an available user manager without relying on the daemon installer marker. */
export async function inspectHostServiceManager(
  home: string,
  options: {
    platform?: NodeJS.Platform;
    uid?: number;
    run?: CompilationCommandRunner;
  } = {},
): Promise<Pick<ServiceTarget, 'kind' | 'domain'>> {
  const platform = options.platform ?? process.platform;
  const kind = platform === 'linux' ? 'systemd' : platform === 'darwin' ? 'launchd' : null;
  const uid = options.uid ?? process.getuid?.();
  if (!kind || uid === undefined) throw new Error('No supported independent supervisor');
  return inspectServiceManager(home, kind, uid, options.run);
}

/** Probe only; never start a manager or register a service during inspection. */
export async function inspectServiceManager(
  home: string,
  kind: ServiceTarget['kind'],
  uid: number,
  run?: CompilationCommandRunner,
): Promise<Pick<ServiceTarget, 'kind' | 'domain'>> {
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('Invalid host user');
  const execute = supervisorCommand(home, run);
  if (kind === 'systemd') {
    // Avoid show-environment: it needlessly reads potentially secret values.
    await execute('systemctl', ['--user', 'show', '--property=Version']);
    return { kind, domain: null };
  }
  const domain = `gui/${uid}`;
  // Only success matters. Do not parse launchctl's diagnostic print output.
  await execute('/bin/launchctl', ['print-disabled', domain]);
  return { kind, domain };
}

/** Confirm the exact running service, not a stale installer marker or recorded PID. */
export async function inspectRunningService(
  home: string,
  target: ServiceTarget,
  expectedPid: number,
  run?: CompilationCommandRunner,
): Promise<ServiceObservation> {
  validServiceTarget(target);
  if (!Number.isSafeInteger(expectedPid) || expectedPid < 1)
    throw new Error('Invalid host service process');
  const execute = supervisorCommand(home, run);
  if (target.kind === 'systemd') {
    // MainPID reflects the current process; ExecMainPID can describe an old run.
    // https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.systemd1.html
    const properties = [
      'Id',
      'LoadState',
      'ActiveState',
      'SubState',
      'MainPID',
      'InvocationID',
      'ControlGroup',
      'NeedDaemonReload',
      'CanStart',
      'CanStop',
    ];
    const response = await execute('systemctl', [
      '--user',
      'show',
      `--property=${properties.join(',')}`,
      target.name,
    ]);
    const values = new Map<string, string>();
    for (const line of response.stdout.trim().split('\n')) {
      const equal = line.indexOf('=');
      if (equal < 1) throw new Error('Invalid systemd service observation');
      const key = line.slice(0, equal);
      if (values.has(key)) throw new Error('Ambiguous systemd service observation');
      values.set(key, line.slice(equal + 1));
    }
    const group = values.get('ControlGroup') ?? '';
    const invocation = values.get('InvocationID') ?? '';
    if (
      values.get('Id') !== target.name ||
      values.get('LoadState') !== 'loaded' ||
      values.get('ActiveState') !== 'active' ||
      values.get('SubState') !== 'running' ||
      values.get('MainPID') !== String(expectedPid) ||
      values.get('NeedDaemonReload') !== 'no' ||
      values.get('CanStart') !== 'yes' ||
      values.get('CanStop') !== 'yes' ||
      !/^[0-9a-f]{32}$/.test(invocation) ||
      !group.startsWith('/') ||
      !group.endsWith(`/${target.name}`) ||
      group.split('/').includes('..')
    )
      throw new Error('Systemd service does not match the running daemon');
    return { ...target, pid: expectedPid, invocation, controlGroup: group };
  }
  if ((await inspectLaunchdProcess(home, target, run)) !== expectedPid)
    throw new Error('Launchd service does not match the running daemon');
  return { ...target, pid: expectedPid, invocation: null, controlGroup: null };
}
