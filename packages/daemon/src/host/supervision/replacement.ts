import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hostServiceReplacementSchema, type HostServiceReplacement } from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import {
  CompilationCommandError,
  type CompilationCommandRunner,
} from '../../compilation/process.js';
import { supervisorCommand, validServicePath } from '../services.js';
import {
  inspectRunningService,
  validServiceTarget,
  type ServiceObservation,
  type ServiceTarget,
} from './inspection.js';

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

async function definitionDigest(
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

/** Capture the existing configuration; do not regenerate or rewrite users' service settings. */
export async function prepareServiceReplacement(
  home: string,
  observed: ServiceObservation,
  options: {
    definitionPath?: string;
    component?: 'daemon' | 'connector';
    run?: CompilationCommandRunner;
  } = {},
): Promise<HostServiceReplacement> {
  const definition_path =
    observed.kind === 'launchd'
      ? (options.definitionPath ??
        join(homedir(), 'Library', 'LaunchAgents', `${observed.name}.plist`))
      : null;
  const definition_digest = await definitionDigest(
    home,
    observed,
    definition_path,
    options.run,
    options.component,
  );
  const current = await inspectRunningService(home, observed, observed.pid, options.run);
  if (current.invocation !== observed.invocation || current.controlGroup !== observed.controlGroup)
    throw new Error('Host service changed during replacement preparation');
  return hostServiceReplacementSchema.parse({
    ...current,
    definition_path,
    definition_digest,
    ...(options.component ? { component: options.component } : {}),
  });
}

async function unchangedDefinition(
  home: string,
  service: HostServiceReplacement,
  run?: CompilationCommandRunner,
) {
  if (
    (await definitionDigest(home, service, service.definition_path, run, service.component)) !==
    service.definition_digest
  )
    throw new Error('Host service configuration changed');
}

/** A stopped supervisor must not be able to restart the outgoing process automatically. */
export async function serviceIsStopped(
  home: string,
  target: ServiceTarget,
  run?: CompilationCommandRunner,
): Promise<boolean> {
  validServiceTarget(target);
  const execute = supervisorCommand(home, run);
  if (target.kind === 'systemd') {
    const response = await execute('systemctl', [
      '--user',
      'show',
      '--property=Id,LoadState,ActiveState,SubState,MainPID,NeedDaemonReload',
      target.name,
    ]);
    const expected = new Map([
      ['Id', target.name],
      ['LoadState', 'loaded'],
      ['ActiveState', 'inactive'],
      ['SubState', 'dead'],
      ['MainPID', '0'],
      ['NeedDaemonReload', 'no'],
    ]);
    const lines = response.stdout.trim().split('\n');
    return (
      lines.length === expected.size &&
      lines.every((line) => {
        const split = line.indexOf('=');
        const key = line.slice(0, split);
        if (split < 1 || expected.get(key) !== line.slice(split + 1)) return false;
        expected.delete(key);
        return true;
      })
    );
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

/** Issue exactly one stop; a lost reply is uncertain and must never cause a second mutation. */
export async function stopServiceForReplacement(
  home: string,
  input: HostServiceReplacement,
  beforeStop: () => void,
  run?: CompilationCommandRunner,
): Promise<void> {
  const service = hostServiceReplacementSchema.parse(input);
  await unchangedDefinition(home, service, run);
  const current = await inspectRunningService(home, service, service.pid, run);
  if (current.invocation !== service.invocation || current.controlGroup !== service.controlGroup)
    throw new Error('Outgoing host service was replaced');
  beforeStop();
  const execute = supervisorCommand(home, run);
  if (service.kind === 'systemd') await execute('systemctl', ['--user', 'stop', service.name]);
  else await execute('/bin/launchctl', ['bootout', `${service.domain}/${service.name}`]);
}

/** Start the same definition once, after selection and checkpoint verification by the worker. */
export async function startReplacementService(
  home: string,
  input: HostServiceReplacement,
  run?: CompilationCommandRunner,
): Promise<void> {
  const service = hostServiceReplacementSchema.parse(input);
  await unchangedDefinition(home, service, run);
  if (!(await serviceIsStopped(home, service, run))) throw new Error('Host service is not stopped');
  const execute = supervisorCommand(home, run);
  if (service.kind === 'systemd') await execute('systemctl', ['--user', 'start', service.name]);
  else await execute('/bin/launchctl', ['bootstrap', service.domain!, service.definition_path!]);
}
