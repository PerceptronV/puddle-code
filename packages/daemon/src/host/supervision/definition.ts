import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from '@puddle/shared/node';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import { supervisorCommand, validServicePath } from '../services.js';
import { validServiceTarget, type ServiceTarget } from './inspection.js';

/** Corroborate the loaded systemd command before starting a service without a live PID. */
export async function requireSelectedDaemonExecutable(
  home: string,
  service: ServiceTarget,
  run?: CompilationCommandRunner,
): Promise<void> {
  validServiceTarget(service);
  if (service.kind !== 'systemd') return; // The launchd plist check below validates its arguments.
  const response = await supervisorCommand(home, run)('systemctl', [
    '--user',
    'show',
    '--property=ExecStart',
    '--value',
    service.name,
  ]);
  // systemctl show's ExecStart property prints one record per command. Accept
  // one literal selected wrapper; do not parse a unit file or evaluate arguments.
  // Format checked against systemd v254 src/systemctl/systemctl-show.c (print_property).
  // https://github.com/systemd/systemd/blob/v254/src/systemctl/systemctl-show.c
  const match = /^\{ path=([^;\r\n]+) ; argv\[\]=[^\r\n]* \}$/.exec(response.stdout.trim());
  if (!match || match[1] !== join(home, 'bin/current/puddled'))
    throw new Error('Systemd definition does not start the selected daemon');
}

async function plistBytes(path: string): Promise<string> {
  validServicePath(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o022) !== 0 ||
      stat.size > 64 * 1024
    )
      throw new Error('Unsafe launchd definition');
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== stat.size || read.bytesRead > 64 * 1024)
      throw new Error('Launchd definition changed during inspection');
    // Base64 also preserves binary plists exactly for the fingerprint.
    return bytes.subarray(0, read.bytesRead).toString('base64');
  } finally {
    await file.close();
  }
}

export async function serviceDefinitionDigest(
  home: string,
  service: ServiceTarget,
  path: string | null,
  run?: CompilationCommandRunner,
  component: 'daemon' | 'connector' = 'daemon',
) {
  validServiceTarget(service);
  const execute = supervisorCommand(home, run);
  const output = async (file: string, args: string[]) => {
    try {
      return (await execute(file, args)).stdout;
    } catch {
      throw new Error('Host service configuration is unavailable');
    }
  };
  if (service.kind === 'systemd') {
    // cat includes the unit and every drop-in; retain only its digest, never its environment.
    const definition = await output('systemctl', ['--user', 'cat', '--no-pager', service.name]);
    if (!definition.trim()) throw new Error('Missing systemd definition');
    return digest(definition);
  }
  if (!path) throw new Error('Missing launchd definition');
  const before = await plistBytes(path);
  // plutil's JSON conversion is machine-readable; launchctl print is not.
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await output('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', path]),
    );
  } catch {
    // Supervisor/conversion errors can contain configuration environment values.
    throw new Error('Launchd definition could not be inspected');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid launchd definition');
  const plist = parsed as Record<string, unknown>;
  const args =
    component === 'connector'
      ? [join(home, 'bin/current/bin/node'), join(home, 'bin/current/daemon/connector.mjs')]
      : [join(home, 'bin/current/puddled')];
  const argumentsList = plist.ProgramArguments;
  if (
    plist.Label !== service.name ||
    !Array.isArray(argumentsList) ||
    args.some((arg, index) => argumentsList[index] !== arg) ||
    (plist.Program !== undefined && plist.Program !== args[0])
  )
    throw new Error('Launchd definition does not start the selected component');
  if ((await plistBytes(path)) !== before)
    throw new Error('Launchd definition changed during inspection');
  return digest(before);
}
