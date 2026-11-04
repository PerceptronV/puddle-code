import type { CompilationCommandRunner } from '../../compilation/process.js';
import { supervisorCommand } from '../services.js';
import { validServiceTarget, type ServiceTarget } from './target.js';

/** A loaded job without a process may start itself; this is not evidence of removal. */
export async function inspectLaunchdProcess(
  home: string,
  target: ServiceTarget,
  run?: CompilationCommandRunner,
): Promise<number | null> {
  validServiceTarget(target);
  if (target.kind !== 'launchd') throw new Error('Expected a launchd service');
  const execute = supervisorCommand(home, run);
  // print's format is explicitly not an API. Its exit status verifies the exact
  // GUI registration; the documented legacy list columns identify the live PID.
  // Verified against the macOS 26.5.2 launchctl(1) manual.
  // list uses the caller's context. Establish that it is the same GUI manager,
  // rather than accepting a same-labelled job in a separate user domain.
  const context = await execute('/bin/launchctl', ['managername']);
  const user = await execute('/bin/launchctl', ['manageruid']);
  if (context.stdout.trim() !== 'Aqua' || `gui/${user.stdout.trim()}` !== target.domain)
    throw new Error('Launchd inspection is outside the expected GUI context');
  await execute('/bin/launchctl', ['print', `${target.domain}/${target.name}`]);
  const listed = await execute('/bin/launchctl', ['list']);
  const matches = listed.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns[2] === target.name);
  if (matches.length !== 1 || matches[0]!.length !== 3 || !/^-?\d+$/.test(matches[0]![1]!))
    throw new Error('Ambiguous launchd service observation');
  const pid = matches[0]![0]!;
  if (pid === '-') return null;
  if (!/^[1-9][0-9]*$/.test(pid) || !Number.isSafeInteger(Number(pid)))
    throw new Error('Invalid launchd service process');
  return Number(pid);
}
