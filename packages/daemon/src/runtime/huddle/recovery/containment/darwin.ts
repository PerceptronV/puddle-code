import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { constants, accessSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  canonicalHuddleJson,
  huddleContainmentSchema,
  runtimeSupervisorSchema,
  type HuddleContainment,
  type HuddleOwnerLaunch,
} from '@puddle/shared';
import { readRuntimeJson } from '../../../ownership/storage.js';
import { runtimeServiceName, removeRuntimeService } from '../../../lifecycle/supervisor.js';
import { retainedHuddleDirectory } from '../../state/readers/database.js';

type DarwinContainment = Extract<HuddleContainment, { kind: 'darwin-resource-coalition' }>;
const counter = z
  .string()
  .regex(/^[0-9]{1,20}$/)
  .refine((v) => BigInt(v) <= 0xffffffffffffffffn);
const observation = z.discriminatedUnion('state', [
  z.strictObject({ format: z.literal(1), coalition: counter, state: z.literal('reaped') }),
  z.strictObject({
    format: z.literal(1),
    coalition: counter,
    state: z.enum(['populated', 'empty']),
    started: counter,
    exited: counter,
  }),
]);

function helper(home: string, launch: HuddleOwnerLaunch) {
  if (process.platform !== 'darwin' || launch.capabilities.coalitionRecovery !== 1)
    throw new Error('This owner has no macOS coalition recovery support');
  const supervisor = runtimeSupervisorSchema.parse(
    readRuntimeJson(
      join(retainedHuddleDirectory(home, launch.identity.runtime_id), 'supervisor.json'),
    ),
  );
  if (
    supervisor.kind !== 'launchd' ||
    supervisor.domain !== `gui/${process.getuid!()}` ||
    supervisor.name !== runtimeServiceName(home, launch.identity, 'launchd') ||
    canonicalHuddleJson(supervisor.identity) !== canonicalHuddleJson(launch.identity)
  )
    throw new Error('Huddle coalition supervisor identity changed');
  // The source owner's immutable release remains retained by its unresolved binding.
  const entry = realpathSync(supervisor.entry_path);
  if (entry !== supervisor.entry_path) throw new Error('Pinned huddle runtime entry changed');
  const executable = join(dirname(entry), 'huddle', 'darwin-containment');
  if (realpathSync(executable) !== executable || !statSync(executable).isFile())
    throw new Error('Pinned huddle coalition probe is unavailable');
  accessSync(executable, constants.X_OK);
  return executable;
}
function probe(
  home: string,
  launch: HuddleOwnerLaunch,
  mode: 'capture' | 'observe',
  value: string,
) {
  let raw: string;
  try {
    raw = execFileSync(helper(home, launch), [mode, value], {
      timeout: 3000,
      maxBuffer: 4096,
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error('macOS coalition observation is unavailable', { cause: error });
  }
  const result = observation.parse(JSON.parse(raw));
  if (mode === 'observe' && result.coalition !== value)
    throw new Error('Coalition probe changed identity');
  if (
    result.state !== 'reaped' &&
    (BigInt(result.exited) > BigInt(result.started) ||
      (result.state === 'empty') !== (result.started === result.exited))
  )
    throw new Error('Coalition counters disagree');
  return result;
}
export function captureDarwinContainment(
  home: string,
  launch: HuddleOwnerLaunch,
): DarwinContainment | null {
  if (
    process.platform !== 'darwin' ||
    launch.capabilities.coalitionRecovery !== 1 ||
    !launch.boot_id
  )
    return null;
  try {
    const captured = probe(home, launch, 'capture', String(process.pid));
    if (captured.state !== 'populated') return null;
    return {
      format: 1,
      kind: 'darwin-resource-coalition',
      identity: launch.identity,
      boot: launch.boot_id,
      coalition: captured.coalition,
    };
  } catch {
    // Missing/unsupported native evidence preserves ordinary execution and reboot-only recovery.
    return null;
  }
}
export function hasDarwinContainment(
  home: string,
  launch: HuddleOwnerLaunch,
  record: DarwinContainment,
) {
  helper(home, launch);
  return (
    record.boot === launch.boot_id &&
    canonicalHuddleJson(record.identity) === canonicalHuddleJson(launch.identity)
  );
}
export class HuddleContainmentRetirementRequired extends Error {
  constructor(
    readonly launch: HuddleOwnerLaunch,
    readonly record: DarwinContainment,
  ) {
    super('The empty huddle coalition needs normal service retirement before recovery');
  }
}
export function requireDarwinDescendantsEnded(
  home: string,
  launch: HuddleOwnerLaunch,
  record: DarwinContainment,
) {
  const result = probe(home, launch, 'observe', record.coalition);
  if (result.state === 'empty') throw new HuddleContainmentRetirementRequired(launch, record);
  if (result.state !== 'reaped')
    throw new Error('Huddle script descendants have not been confirmed stopped');
}
/** Use normal retirement, only after fresh empty-scope evidence inside its owner/dispatch claims. */
export async function retireEmptyDarwinContainment(
  home: string,
  request: HuddleContainmentRetirementRequired,
) {
  const { launch, record } = request;
  const outcome = await removeRuntimeService(home, launch.identity, undefined, () => {
    const retained = huddleContainmentSchema.parse(
      readRuntimeJson(
        join(retainedHuddleDirectory(home, launch.identity.runtime_id), 'huddle-containment.json'),
      ),
    );
    if (canonicalHuddleJson(retained) !== canonicalHuddleJson(record))
      throw new Error('Huddle containment changed before retirement');
    const result = probe(home, launch, 'observe', record.coalition);
    if (result.state === 'populated') throw new Error('Huddle descendants remain alive');
  });
  if (outcome === 'owned') throw new Error('Huddle owner remains live during recovery');
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      requireDarwinDescendantsEnded(home, launch, record);
      return;
    } catch (error) {
      if (!(error instanceof HuddleContainmentRetirementRequired) || Date.now() >= deadline)
        throw error;
      await delay(25);
    }
  }
}
