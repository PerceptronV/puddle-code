import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

/** Bounded public metadata from an already resolved immutable release tree. */
export function readReleaseText(file: string, limit: number): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('Invalid release metadata');
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, size);
      if (count === 0) break;
      size += count;
    }
    if (size !== stat.size) throw new Error('Release metadata changed during inspection');
    return buffer.subarray(0, size).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
