import { constants, realpathSync, accessSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  compatibleRuntimeProtocol,
  parseHostReleaseVersion,
  parseReleaseProtocol,
} from '@puddle/shared';
import { readReleaseText } from '../../host/releases/files.js';

/** Resolve the selector once; every executable and metadata read uses that tree. */
export function resolveInstalledRuntimeRelease(home: string) {
  const versions = realpathSync(join(home, 'bin', 'versions'));
  const releasePath = realpathSync(join(home, 'bin', 'runtime-current'));
  if (dirname(releasePath) !== versions)
    throw new Error('Runtime selector is outside installed releases');
  const build = parseHostReleaseVersion(readReleaseText(join(releasePath, 'VERSION'), 129));
  const protocol = parseReleaseProtocol(readReleaseText(join(releasePath, 'RUNTIME_PROTOCOL'), 33));
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
