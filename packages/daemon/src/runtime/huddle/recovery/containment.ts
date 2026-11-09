import {
  captureDarwinContainment,
  hasDarwinContainment,
  requireDarwinDescendantsEnded,
} from './containment/darwin.js';
import {
  closeSync,
  constants,
  openSync,
  readSync,
  readlinkSync,
  realpathSync,
  statSync,
  statfsSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  canonicalHuddleJson,
  huddleContainmentSchema,
  runtimeSupervisorSchema,
  type HuddleContainment,
  type HuddleOwnerLaunch,
} from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { readRuntimeJson } from '../../ownership/storage.js';
import { runtimeServiceName } from '../../lifecycle/supervisor.js';
import { retainedHuddleDirectory } from '../state/readers/database.js';

const root = '/sys/fs/cgroup';
const cgroup2Magic = 0x63677270;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Kernel pseudo-files have zero stat size; bound the read itself. */
function kernelText(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let bytes = 0;
    for (;;) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      bytes += count;
      if (bytes === buffer.length) throw new Error('Cgroup observation exceeds its bound');
      if (count === 0) return buffer.subarray(0, bytes).toString('utf8');
    }
  } finally {
    closeSync(fd);
  }
}
function hierarchy() {
  if (
    process.platform !== 'linux' ||
    statfsSync(root).type !== cgroup2Magic ||
    realpathSync(root) !== root
  )
    throw new Error('Same-boot huddle recovery needs the host cgroup v2 hierarchy');
  return {
    device: statSync(root, { bigint: true }).dev.toString(),
    namespace: readlinkSync('/proc/self/ns/cgroup'),
  };
}
function location(path: string, service: string) {
  if (
    !path.startsWith('/') ||
    path
      .split('/')
      .slice(1)
      .some((part) => !part || part === '.' || part === '..') ||
    basename(path) !== service
  )
    throw new Error('Huddle containment is not its exact independent service');
  return root + path;
}
const recordPath = (home: string, launch: HuddleOwnerLaunch) =>
  join(retainedHuddleDirectory(home, launch.identity.runtime_id), 'huddle-containment.json');

/** Capture before any project code can run. Unsupported lifetimes retain reboot-only recovery. */
export function recordHuddleContainment(home: string, launch: HuddleOwnerLaunch): void {
  if (process.platform === 'darwin') {
    const record = captureDarwinContainment(home, launch);
    if (!record) return;
    const file = recordPath(home, launch);
    try {
      const existing = huddleContainmentSchema.parse(readRuntimeJson(file));
      if (canonicalHuddleJson(existing) !== canonicalHuddleJson(record))
        throw new Error('Huddle containment identity changed');
    } catch (error) {
      if (!missing(error)) throw error;
      atomicPrivateJson(file, record, { syncDirectory: true });
    }
    return;
  }
  if (process.platform !== 'linux' || launch.capabilities.crashRecovery !== 1 || !launch.boot_id)
    return;
  const supervisor = runtimeSupervisorSchema.parse(
    readRuntimeJson(
      join(retainedHuddleDirectory(home, launch.identity.runtime_id), 'supervisor.json'),
    ),
  );
  if (supervisor.kind !== 'systemd') return;
  if (canonicalHuddleJson(supervisor.identity) !== canonicalHuddleJson(launch.identity))
    throw new Error('Huddle supervisor identity changed');
  // A v1 host may still run huddles, but cannot produce this recovery proof.
  if (statfsSync(root).type !== cgroup2Magic) return;
  const host = hierarchy();
  const entries = kernelText('/proc/self/cgroup').trim().split('\n');
  const unified = entries.filter((entry) => entry.startsWith('0::'));
  if (unified.length !== 1) throw new Error('Huddle cgroup membership is unavailable');
  const path = unified[0]!.slice(3);
  const service = runtimeServiceName(home, launch.identity, 'systemd');
  if (supervisor.name !== service) throw new Error('Huddle supervisor name changed');
  const directory = location(path, service);
  if (
    realpathSync(directory) !== directory ||
    !kernelText(join(directory, 'cgroup.procs')).trim().split('\n').includes(String(process.pid))
  )
    throw new Error('Huddle is not contained in its recorded service');
  const stat = statSync(directory, { bigint: true });
  if (stat.dev.toString() !== host.device) throw new Error('Huddle cgroup mount changed');
  const record = huddleContainmentSchema.parse({
    format: 1,
    identity: launch.identity,
    boot: launch.boot_id,
    kind: 'cgroup-v2',
    path,
    device: host.device,
    inode: stat.ino.toString(),
    namespace: host.namespace,
  });
  const file = recordPath(home, launch);
  try {
    const existing = huddleContainmentSchema.parse(readRuntimeJson(file));
    if (canonicalHuddleJson(existing) !== canonicalHuddleJson(record))
      throw new Error('Huddle containment was already recorded for another service scope');
  } catch (error) {
    if (!missing(error)) throw error;
    atomicPrivateJson(file, record, { syncDirectory: true });
  }
}

/** Caller holds all source retirement/state claims; no PID or service-status guess substitutes. */
export function requireHuddleDescendantsEnded(
  home: string,
  launch: HuddleOwnerLaunch,
  expected?: HuddleContainment,
): HuddleContainment {
  if (launch.capabilities.crashRecovery !== 1 || !launch.boot_id)
    throw new Error('This owner only supports recovery after a verified host reboot');
  let record: HuddleContainment;
  try {
    record = huddleContainmentSchema.parse(readRuntimeJson(recordPath(home, launch)));
  } catch (error) {
    if (missing(error))
      throw new Error('This owner has no retained kernel containment proof; use reboot recovery', {
        cause: error,
      });
    throw error;
  }
  if (
    record.boot !== launch.boot_id ||
    canonicalHuddleJson(record.identity) !== canonicalHuddleJson(launch.identity) ||
    (expected && canonicalHuddleJson(record) !== canonicalHuddleJson(expected))
  )
    throw new Error('Huddle containment provenance changed');
  if (record.kind === 'darwin-resource-coalition') {
    requireDarwinDescendantsEnded(home, launch, record);
    return record;
  }
  const host = hierarchy();
  if (host.device !== record.device || host.namespace !== record.namespace)
    throw new Error('Huddle cgroup hierarchy or namespace changed');
  const directory = location(record.path, runtimeServiceName(home, launch.identity, 'systemd'));
  let stat;
  try {
    if (realpathSync(directory) !== directory) throw new Error('Huddle cgroup path changed');
    stat = statSync(directory, { bigint: true });
  } catch (error) {
    // Kernel cgroups can be removed only after they and their descendants are empty.
    if (missing(error)) return record;
    throw error;
  }
  if (stat.dev.toString() !== record.device || stat.ino.toString() !== record.inode)
    throw new Error('Huddle cgroup identity changed');
  const states = kernelText(join(directory, 'cgroup.events'))
    .trim()
    .split('\n')
    .filter((line) => line.startsWith('populated '));
  if (states.length !== 1 || states[0] !== 'populated 0')
    throw new Error('Huddle script descendants have not been confirmed stopped');
  return record;
}

/** Offer only where retained metadata matches this host; dispatch still proves empty scope under claims. */
export function hasHuddleContainment(home: string, launch: HuddleOwnerLaunch): boolean {
  if (!['linux', 'darwin'].includes(process.platform) || launch.capabilities.crashRecovery !== 1)
    return false;
  try {
    const record = huddleContainmentSchema.parse(readRuntimeJson(recordPath(home, launch)));
    if (record.kind === 'darwin-resource-coalition')
      return hasDarwinContainment(home, launch, record);
    const host = hierarchy();
    location(record.path, runtimeServiceName(home, launch.identity, 'systemd'));
    return (
      record.boot === launch.boot_id &&
      record.device === host.device &&
      record.namespace === host.namespace &&
      canonicalHuddleJson(record.identity) === canonicalHuddleJson(launch.identity)
    );
  } catch {
    return false;
  }
}
