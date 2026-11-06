import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';

/** Only update preparation calls this; observation must never repair host files. */
export async function repairSupervisorMarker(
  home: string,
  uid: number,
  corroborate: (kind: 'systemd' | 'launchd') => Promise<void>,
  requireAuthority: () => void,
): Promise<void> {
  const directory = lstatSync(home);
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o022) !== 0)
    throw new Error('Unsafe supervisor marker directory');
  const path = join(home, 'supervisor');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== uid || before.nlink !== 1 || before.size > 32)
      throw new Error('Unsafe supervisor marker');
    if ((before.mode & 0o022) === 0) return;
    const read = () => {
      const buffer = Buffer.alloc(33);
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, length).toString('utf8');
    };
    const contents = read();
    const kind = contents.trim();
    if (kind !== 'systemd' && kind !== 'launchd') throw new Error('Unknown supervisor marker');
    await corroborate(kind);
    // Keep the opened inode pinned across probes. Reject replacement, new links,
    // permission/content changes and lost authority before the synchronous chmod.
    const current = fstatSync(fd);
    const named = lstatSync(path);
    const parent = lstatSync(home);
    if (
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      named.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.uid !== uid ||
      current.mode !== before.mode ||
      current.ctimeMs !== before.ctimeMs ||
      current.mtimeMs !== before.mtimeMs ||
      current.size !== before.size ||
      read() !== contents ||
      parent.dev !== directory.dev ||
      parent.ino !== directory.ino ||
      !parent.isDirectory() ||
      parent.uid !== uid ||
      (parent.mode & 0o022) !== 0
    )
      throw new Error('Supervisor marker changed during repair');
    requireAuthority();
    fchmodSync(fd, before.mode & 0o7777 & ~0o022);
  } finally {
    closeSync(fd);
  }
}
