import { serviceDefinitionDigest } from './definition.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hostServiceReplacementSchema, type HostServiceReplacement } from '@puddle/shared';
import {
  CompilationCommandError,
  type CompilationCommandRunner,
} from '../../compilation/process.js';
import { supervisorCommand } from '../services.js';
import {
  inspectRunningService,
  validServiceTarget,
  type ServiceObservation,
  type ServiceTarget,
} from './inspection.js';

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
  const definition_digest = await serviceDefinitionDigest(
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

export async function requireUnchangedServiceDefinition(
  home: string,
  service: HostServiceReplacement,
  run?: CompilationCommandRunner,
) {
  if (
    (await serviceDefinitionDigest(
      home,
      service,
      service.definition_path,
      run,
      service.component,
    )) !== service.definition_digest
  )
    throw new Error('Host service configuration changed');
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
    const response = await execute('systemctl', [
      '--user',
      'show',
      '--property=Id,LoadState,ActiveState,SubState,MainPID,NeedDaemonReload',
      target.name,
    ]);
    const failed = allowFailed && response.stdout.split('\n').includes('ActiveState=failed');
    const expected = new Map([
      ['Id', target.name],
      ['LoadState', 'loaded'],
      ['ActiveState', failed ? 'failed' : 'inactive'],
      ['SubState', failed ? 'failed' : 'dead'],
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
  await requireUnchangedServiceDefinition(home, service, run);
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
  allowFailed = false,
): Promise<void> {
  const service = hostServiceReplacementSchema.parse(input);
  await requireUnchangedServiceDefinition(home, service, run);
  if (!(await serviceIsStopped(home, service, run, allowFailed)))
    throw new Error('Host service is not stopped');
  const execute = supervisorCommand(home, run);
  if (service.kind === 'systemd') await execute('systemctl', ['--user', 'start', service.name]);
  else await execute('/bin/launchctl', ['bootstrap', service.domain!, service.definition_path!]);
}
