import { RUNTIME_LIMITS, runtimeIdentitySchema, runtimeTerminalSchema } from '@puddle/shared';
import { SCREEN_LIMITS } from '../../pty/screen/limits.js';

export type RuntimeStorageCategory =
  'rawLogs' | 'checkpoints' | 'screens' | 'metadata' | 'protected' | 'temporary' | 'unknown';

const uuid = (value: string) => runtimeIdentitySchema.shape.runtime_id.safeParse(value).success;
const terminal = (value: string) => runtimeTerminalSchema.shape.term.safeParse(value).success;
const metadata = new Set([
  'launch.json',
  'state.json',
  'events.json',
  'consumed.json',
  'retired.json',
  'assets.json',
  'supervisor.json',
  'release-retirement.json',
  'runtime.plist',
]);
const temporary =
  /\.(?:[a-f0-9]{64}|[a-f0-9-]{36})\.tmp$|\.tmp-[1-9][0-9]*(?:-[0-9]+)?$|\.retention-[a-f0-9-]{36}$/;

/** Classification is accounting only: even recognised temporary files are never deletion candidates here. */
export function runtimeStorageCategory(
  relative: string,
  directory: boolean,
): RuntimeStorageCategory {
  if (!directory && temporary.test(relative)) {
    const base = relative.replace(temporary, '');
    return runtimeStorageCategory(base, false) === 'unknown' ? 'unknown' : 'temporary';
  }
  const parts = relative.split('/');
  const [root, stream, name] = parts;
  if (!directory && ['.journal-0.tmp', '.state-0.tmp'].includes(relative)) return 'temporary';
  const slot = /^\.checkpoint-(0|[1-9][0-9]{0,2})\.tmp$/.exec(stream ?? '');
  if (
    !directory &&
    root === 'segments' &&
    parts.length === 2 &&
    slot &&
    Number(slot[1]) < RUNTIME_LIMITS.pendingCheckpoints
  )
    return 'temporary';
  const screenSlot = /^\.screen-write-(0|[1-9][0-9]{0,2})\.tmp$/.exec(stream ?? '');
  if (
    !directory &&
    root === 'screens' &&
    parts.length === 2 &&
    screenSlot &&
    Number(screenSlot[1]) < SCREEN_LIMITS.scratchFiles
  )
    return 'temporary';
  if (parts.length === 1) {
    if (directory && ['logs', 'segments', 'screens'].includes(root!)) return 'metadata';
    if (
      directory &&
      (['helpers', 'shell-hooks', 'hook-state'].includes(root!) ||
        /^\.helpers-[a-f0-9-]{36}$/.test(root!))
    )
      return 'protected';
    if (
      !directory &&
      (metadata.has(root!) || /^puddler-[a-f0-9]{8}-[a-f0-9-]{36}\.service$/.test(root!))
    )
      return 'metadata';
    return 'unknown';
  }
  // Pinned hooks and provider hook state are accounted separately, never compacted.
  if (
    ['helpers', 'shell-hooks', 'hook-state'].includes(root!) ||
    /^\.helpers-[a-f0-9-]{36}$/.test(root!)
  )
    return 'protected';
  if (root === 'logs' || root === 'screens') {
    if (!uuid(stream!)) return 'unknown';
    if (directory) return parts.length === 2 ? 'metadata' : 'unknown';
    if (parts.length !== 3) return 'unknown';
    if (name === 'shell-history') return 'protected';
    if (root === 'screens')
      return terminal(name!.replace(/\.terminal\.json$/, '')) && name!.endsWith('.terminal.json')
        ? 'screens'
        : 'unknown';
    const match = /^(agent|shell-[1-9][0-9]{0,5})\.([a-f0-9-]{36})\.log$/i.exec(name!);
    return match && uuid(match[2]!) ? 'rawLogs' : 'unknown';
  }
  if (root === 'segments' && !directory && parts.length === 2) {
    const match = /^([a-f0-9-]{36})\.(agent|shell-[1-9][0-9]{0,5})\.([a-f0-9-]{36})\.json$/i.exec(
      stream!,
    );
    return match && uuid(match[1]!) && uuid(match[3]!) ? 'checkpoints' : 'unknown';
  }
  return 'unknown';
}
