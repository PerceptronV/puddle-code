import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  accessSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  compatibleRuntimeProtocol,
  parseHostReleaseVersion,
  parseReleaseProtocol,
} from '@puddle/shared';

function metadata(file: string, limit: number): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('Invalid runtime release metadata');
    const buffer = Buffer.alloc(limit + 1);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size > limit) throw new Error('Runtime release metadata exceeds its limit');
    return buffer.subarray(0, size).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Resolve the selector once; every executable and metadata read uses that tree. */
export function resolveInstalledRuntimeRelease(home: string) {
  const versions = realpathSync(join(home, 'bin', 'versions'));
  const releasePath = realpathSync(join(home, 'bin', 'runtime-current'));
  if (dirname(releasePath) !== versions)
    throw new Error('Runtime selector is outside installed releases');
  const build = parseHostReleaseVersion(metadata(join(releasePath, 'VERSION'), 129));
  const protocol = parseReleaseProtocol(metadata(join(releasePath, 'RUNTIME_PROTOCOL'), 33));
  if (!build || !protocol) throw new Error('Runtime release metadata is invalid');
  if (!compatibleRuntimeProtocol(protocol))
    throw new Error('Selected runtime protocol is incompatible with this daemon');
  const nodePath = realpathSync(join(releasePath, 'bin', 'node'));
  const entryPath = realpathSync(join(releasePath, 'daemon', 'puddler.mjs'));
  if (
    dirname(nodePath) !== join(releasePath, 'bin') ||
    dirname(entryPath) !== join(releasePath, 'daemon')
  )
    throw new Error('Runtime executables must belong to the selected release');
  if (!statSync(nodePath).isFile() || !statSync(entryPath).isFile())
    throw new Error('Runtime executable files are missing');
  accessSync(nodePath, constants.X_OK);
  accessSync(entryPath, constants.R_OK);
  return { releasePath, nodePath, entryPath, build, protocol };
}
