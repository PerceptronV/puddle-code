import { closeSync, constants, fstatSync, fsyncSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  RUNTIME_LIMITS,
  runtimeIdentitySchema,
  runtimeLaunchSchema,
  runtimeRetiredSchema,
  type RuntimeIdentity,
} from '@puddle/shared';
import { readPrivateJson, syncPrivateDirectory } from '@puddle/shared/node';
import type { RuntimeRetirementClaims } from '../../ownership/retirement-claims.js';
import { memoryFile, memoryIo } from './storage.js';

/** Prove the exact delayed-start fence durable before returning any cached owner credit. */
export function retiredGrantProof(
  home: string,
  expected: RuntimeIdentity,
  claims: RuntimeRetirementClaims,
): () => void {
  return memoryIo(home, () => {
    const identity = runtimeIdentitySchema.parse(expected);
    claims.requireCurrent(home, identity.runtime_id);
    const directory = join(home, 'runtimes', identity.runtime_id);
    const launchFile = join(directory, 'launch.json');
    const retiredFile = join(directory, 'retired.json');
    const stamp = (file: string, bytes: number) => {
      const stat = memoryFile(file, bytes);
      return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
    };
    const launchStamp = stamp(launchFile, RUNTIME_LIMITS.frameBytes);
    const retiredStamp = stamp(retiredFile, 64 * 1024);
    const launch = runtimeLaunchSchema.parse(
      readPrivateJson(launchFile, RUNTIME_LIMITS.frameBytes),
    );
    const retired = runtimeRetiredSchema.parse(readPrivateJson(retiredFile, 64 * 1024));
    if (
      [launch.identity, retired.identity].some(
        (value) => JSON.stringify(value) !== JSON.stringify(identity),
      )
    )
      throw new Error('Runtime memory retirement identity changed');
    const requireCurrent = () =>
      memoryIo(home, () => {
        claims.requireCurrent(home, identity.runtime_id);
        if (
          stamp(launchFile, RUNTIME_LIMITS.frameBytes) !== launchStamp ||
          stamp(retiredFile, 64 * 1024) !== retiredStamp
        )
          throw new Error('Runtime memory retirement evidence changed');
      });
    requireCurrent();
    const fd = openSync(retiredFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd),
        named = memoryFile(retiredFile, 64 * 1024);
      if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino)
        throw new Error('Runtime retirement fence inode changed');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncPrivateDirectory(directory);
    syncPrivateDirectory(dirname(directory));
    requireCurrent();
    return requireCurrent;
  });
}
