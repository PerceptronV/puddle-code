import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { HUDDLE_LIMITS, huddleRelativePathSchema } from '@puddle/shared';

/** All discovery is data-only. Reject symlinked components and non-regular files. */
export async function checkedHuddlePath(root: string, path: string): Promise<string> {
  huddleRelativePathSchema.parse(path);
  const parts = path.replace(/^\.\//, '').split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Huddle paths must not be symlinks: ${path}`);
    if (index < parts.length - 1 && !stat.isDirectory())
      throw new Error(`Expected a huddle directory: ${path}`);
  }
  const canonical = await realpath(current);
  const within = relative(root, canonical);
  if (!within || within === '..' || within.startsWith(`..${sep}`) || canonical !== current)
    throw new Error(`Huddle path left its captured root: ${path}`);
  return current;
}

export async function readHuddleFile(root: string, path: string): Promise<string> {
  const file = await checkedHuddlePath(root, path);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > HUDDLE_LIMITS.fileBytes)
      throw new Error(
        `Huddle file must be regular and at most ${HUDDLE_LIMITS.fileBytes} bytes: ${path}`,
      );
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    await checkedHuddlePath(root, path);
    const current = await lstat(file);
    if (
      offset !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== current.ino ||
      before.dev !== current.dev
    )
      throw new Error(`Huddle file changed while reading: ${path}`);
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } finally {
    await handle.close();
  }
}
