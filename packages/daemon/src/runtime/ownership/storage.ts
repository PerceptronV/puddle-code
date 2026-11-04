import { randomUUID } from 'node:crypto';
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
  readPrivateJson,
} from '@puddle/shared/node';
import { acquireHostClaim } from '../../security/claims.js';
import { initialiseRuntimeMemory } from '../resources/host/bootstrap.js';

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
  return readPrivateJson(file, RUNTIME_LIMITS.frameBytes);
}

export function readRuntimeController(home: string): RuntimeControllerRecord {
  initialisePrivateHome(home);
  return runtimeControllerSchema.parse(readRuntimeJson(join(home, 'runtime-controller.json')));
}

/** A surviving owner may briefly hold the ledger writer during daemon replacement. */
export async function acquireRuntimeControllerWhenAvailable(home: string) {
  const deadline = performance.now() + 5000;
  for (;;) {
    try {
      return acquireRuntimeController(home);
    } catch (error) {
      // Do not retry another daemon's ownership, invalid metadata or filesystem
      // failures. SQLITE_BUSY is a definite refusal before controller publication.
      if ((error as { code?: string }).code !== 'SQLITE_BUSY' || performance.now() >= deadline)
        throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** Held for the daemon's lifetime; the kernel releases the claim after a crash. */
export function acquireRuntimeController(home: string) {
  initialiseRuntimeMemory(home);
  const claim = acquireHostClaim(home, 'daemon-controller');
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
