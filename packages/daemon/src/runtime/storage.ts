import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RUNTIME_LIMITS,
  runtimeControllerSchema,
  runtimeIdentitySchema,
  type RuntimeControllerRecord,
} from '@puddle/shared';
import {
  atomicPrivateJson,
  initialisePrivateHome,
  privateDirectory,
  privatePath,
} from '@puddle/shared/node';
import { acquireRuntimeClaim } from './claims.js';

export function runtimeDirectory(home: string, id: string): string {
  runtimeIdentitySchema.shape.runtime_id.parse(id);
  initialisePrivateHome(home);
  const root = join(home, 'runtimes');
  privateDirectory(root);
  const directory = join(root, id);
  privateDirectory(directory);
  return directory;
}

export function readRuntimeJson(file: string): unknown {
  privatePath(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > RUNTIME_LIMITS.frameBytes)
      throw new Error('Invalid runtime record size');
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally {
    closeSync(fd);
  }
}

export function readRuntimeController(home: string): RuntimeControllerRecord {
  initialisePrivateHome(home);
  return runtimeControllerSchema.parse(readRuntimeJson(join(home, 'runtime-controller.json')));
}

/** Held for the daemon's lifetime; the kernel releases the claim after a crash. */
export function acquireRuntimeController(home: string) {
  const claim = acquireRuntimeClaim(home, 'daemon-controller');
  const file = join(home, 'runtime-controller.json');
  try {
    let epoch = 1;
    try {
      epoch = readRuntimeController(home).epoch + 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const record = runtimeControllerSchema.parse({
      format: 1,
      id: randomUUID(),
      epoch,
      active: true,
    });
    atomicPrivateJson(file, record);
    let released = false;
    return {
      record,
      release() {
        if (released) return;
        released = true;
        try {
          atomicPrivateJson(file, { ...record, active: false });
        } finally {
          claim.release();
        }
      },
    };
  } catch (error) {
    claim.release();
    throw error;
  }
}
