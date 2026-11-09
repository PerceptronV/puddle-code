/** Ordinary editable project source, captured with the readout's explicit dependency closure. */
export const fileReportSource = String.raw`import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { HuddleExtensionContext, HuddleDelivery, HuddleDeliveryResult } from 'puddlang/huddle';

const limit = 256 * 1024;
function syncDirectory(directory: string) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const same = (a: fs.BigIntStats, b: fs.BigIntStats) => a.dev === b.dev && a.ino === b.ino &&
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function destination(context: HuddleExtensionContext, delivery: HuddleDelivery) {
  const root = context.bindings.worktree;
  if (!root || !path.isAbsolute(root) || fs.realpathSync(root) !== root ||
      fs.realpathSync(String(context.parameters.worktree)) !== root)
    throw new Error('Report requires its explicit canonical worktree binding');
  const ids: Record<string, string> = { huddleId: delivery.event.scope.huddleId,
    executionId: delivery.event.executionId, invocationId: delivery.invocationId };
  const relative = String(context.parameters.path).replace(/\{\{(huddleId|executionId|invocationId)\}\}/g,
    (_, key: string) => ids[key]!);
  const parts = relative.split('/');
  if (relative.length > 1024 || parts.length > 32 || path.isAbsolute(relative) ||
      /[\\\x00-\x1f{}]/.test(relative) || parts.some((part) => !part || part === '.' || part === '..' ||
        part === '.git' || part === '.puddle'))
    throw new Error('Choose a relative report path outside Git and Puddle metadata');
  return { root, relative, parts, target: path.join(root, relative) };
}

function parent(root: string, parts: string[], create: boolean) {
  if (fs.realpathSync(root) !== root) throw new Error('Report worktree moved');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (create) {
      try { fs.mkdirSync(current); syncDirectory(path.dirname(current)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current)
      throw new Error('Report parent is not a regular directory inside the worktree');
  }
  return current;
}

function observed(target: string, expected: Buffer): boolean {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size !== BigInt(expected.length) || before.size > BigInt(limit)) return false;
    const value = Buffer.alloc(expected.length);
    let offset = 0;
    while (offset < value.length) {
      const count = fs.readSync(fd, value, offset, value.length - offset, offset);
      if (!count) return false;
      offset += count;
    }
    return same(before, fs.fstatSync(fd, { bigint: true })) &&
      same(before, fs.lstatSync(target, { bigint: true })) && hash(value) === hash(expected);
  } finally { fs.closeSync(fd); }
}

export function report(context: HuddleExtensionContext, delivery: HuddleDelivery, observe: boolean): HuddleDeliveryResult {
  context.signal.throwIfAborted();
  let linked = false;
  let temporary: string | undefined;
  try {
    const dest = destination(context, delivery);
    const value = delivery.inputs.value;
    if (context.parameters.format === 'text' && typeof value !== 'string')
      throw new Error('Text reports require a string input; choose JSON for other values');
    const text = context.parameters.format === 'json' ? JSON.stringify(value, null, 2) + '\n' : String(value);
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > limit) throw new Error('Report exceeds 256 KiB');
    const receipt = { worktree: dest.root, path: dest.relative, sha256: hash(bytes), bytes: bytes.length };
    const directory = parent(dest.root, dest.parts, !observe);
    if (observe) {
      if (!observed(dest.target, bytes)) return { status: 'unknown', message: 'Report is absent, changed or differs from the intended content' };
      parent(dest.root, dest.parts, false);
      // This proves the desired file contents, not which process originally wrote them.
      return { status: 'delivered', receipt, outputs: { completed: receipt } };
    }
    const before = fs.lstatSync(directory, { bigint: true });
    temporary = path.join(directory, '.puddle-report-' + randomUUID());
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    context.signal.throwIfAborted();
    parent(dest.root, dest.parts, false);
    const after = fs.lstatSync(directory, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('Report parent changed before publication');
    // A hard link publishes complete bytes atomically and refuses any existing destination.
    fs.linkSync(temporary, dest.target);
    linked = true;
    fs.unlinkSync(temporary);
    temporary = undefined;
    syncDirectory(directory);
    if (!observed(dest.target, bytes)) throw new Error('Report changed after publication');
    parent(dest.root, dest.parts, false);
    return { status: 'delivered', receipt, outputs: { completed: receipt } };
  } catch (error) {
    if (!observe && !linked && (error as NodeJS.ErrnoException).code === 'EEXIST')
      return { status: 'failed', message: 'Report already exists; choose a new path. Existing contents were preserved.' };
    return { status: observe || linked ? 'unknown' : 'failed',
      message: (error instanceof Error ? error.message : 'Report could not be written or observed').slice(0, 4096) };
  } finally {
    if (temporary) { try { fs.unlinkSync(temporary); } catch { /* Never remove the destination to clean up. */ } }
  }
}
`;
