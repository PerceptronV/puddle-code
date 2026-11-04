import {
  CompilationCommandError,
  type CompilationCommandRunner,
} from '../../compilation/process.js';
import { supervisorCommand } from '../services.js';
import { validServiceTarget, type ServiceTarget } from './target.js';

export const systemdServiceProperties =
  'Id,LoadState,ActiveState,SubState,MainPID,NeedDaemonReload';

/** Read bounded machine properties; diagnostics and incomplete replies are not evidence. */
export async function inspectSystemdProperties(
  home: string,
  target: ServiceTarget,
  properties: string,
  run?: CompilationCommandRunner,
  allowMissing = false,
): Promise<Map<string, string> | null> {
  validServiceTarget(target);
  if (target.kind !== 'systemd') throw new Error('Expected a systemd service');
  const execute = supervisorCommand(home, run);
  let response;
  try {
    response = await execute('systemctl', [
      '--user',
      'show',
      `--property=${properties}`,
      target.name,
    ]);
  } catch (error) {
    if (
      !allowMissing ||
      !(error instanceof CompilationCommandError) ||
      error.result?.exitCode !== 4
    )
      throw error;
    response = error.result;
  }
  const values = new Map<string, string>();
  for (const line of response.stdout.trim().split('\n')) {
    const equal = line.indexOf('=');
    const key = line.slice(0, equal);
    if (equal < 1 || values.has(key)) return null;
    values.set(key, line.slice(equal + 1));
  }
  const requested = properties.split(',');
  if (values.size !== requested.length || requested.some((key) => !values.has(key))) return null;
  if (response.exitCode !== 0 && values.get('LoadState') !== 'not-found') return null;
  return values;
}
