import { requireHuddleDescendantsEnded } from './containment.js';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalHuddleJson,
  huddleOwnerLaunchSchema,
  runtimeRetiredSchema,
  type HuddleOwnerLaunch,
} from '@puddle/shared';
import { privatePath } from '@puddle/shared/node';
import { readRuntimeJson } from '../../ownership/storage.js';
import { retainedHuddleDirectory, HUDDLE_READER_LIMITS } from '../state/readers/database.js';

/** Verify the immutable source/fence and pristine seed before SQLite can change any bytes. */
export function verifyHuddleRecoverySeed(home: string, launch: HuddleOwnerLaunch) {
  const recovery = launch.recovery;
  if (!recovery) return;
  const sourceDirectory = retainedHuddleDirectory(home, recovery.source.runtime_id);
  const source = huddleOwnerLaunchSchema.parse(
    readRuntimeJson(join(sourceDirectory, 'launch.json')),
  );
  const retired = runtimeRetiredSchema.parse(
    readRuntimeJson(join(sourceDirectory, 'retired.json')),
  );
  if (
    canonicalHuddleJson(source.identity) !== canonicalHuddleJson(recovery.source) ||
    canonicalHuddleJson(retired.identity) !== canonicalHuddleJson(recovery.source) ||
    source.boot_id !== recovery.sourceBoot ||
    source.scope.hostId !== launch.scope.hostId ||
    source.scope.huddleId !== launch.scope.huddleId ||
    canonicalHuddleJson(recovery.ancestors) !==
      canonicalHuddleJson(
        source.recovery ? [source.recovery.source, ...source.recovery.ancestors] : [],
      )
  )
    throw new Error('Huddle recovery provenance changed');
  if (recovery.containment) requireHuddleDescendantsEnded(home, source, recovery.containment);
  const directory = retainedHuddleDirectory(home, launch.identity.runtime_id);
  const file = join(directory, 'huddle.sqlite');
  if (existsSync(file + '-wal') || existsSync(file + '-journal'))
    throw new Error('Recovery seed has already been opened for writing');
  privatePath(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > HUDDLE_READER_LIMITS.databaseBytes)
      throw new Error('Recovery seed exceeds its physical limit');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!count) throw new Error('Recovery seed changed during verification');
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    if (fstatSync(fd).size !== stat.size || hash.digest('hex') !== recovery.seed)
      throw new Error('Huddle recovery seed changed');
  } finally {
    closeSync(fd);
  }
}
