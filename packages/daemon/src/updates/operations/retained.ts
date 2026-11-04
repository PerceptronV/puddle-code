import { join } from 'node:path';
import {
  hostUpdateOperationSchema,
  hostUpdateTerminal,
  HOST_UPDATE_RECORD_BYTES,
  type HostUpdateOperation,
} from '@puddle/shared';
import {
  atomicPrivateJson,
  privateDirectory,
  privatePath,
  readPrivateJson,
  syncPrivateDirectory,
} from '@puddle/shared/node';

/** Preserve terminal evidence before bounded history eviction; never grants execution authority. */
export function retainTerminalUpdate(
  home: string,
  operation: HostUpdateOperation,
  write = atomicPrivateJson,
): void {
  const valid = hostUpdateOperationSchema.parse(operation);
  if (!hostUpdateTerminal(valid.phase)) throw new Error('Only terminal updates may be retained');
  const directory = join(home, 'updates/retained');
  privateDirectory(directory);
  syncPrivateDirectory(join(home, 'updates'));
  const file = join(directory, `${valid.id}.json`);
  try {
    const previous = readRetainedUpdate(home, valid.id);
    if (JSON.stringify(previous) !== JSON.stringify(valid))
      throw new Error('Retained terminal update changed');
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (Buffer.byteLength(JSON.stringify(valid)) > HOST_UPDATE_RECORD_BYTES)
    throw new Error('Retained update exceeds its limit');
  write(file, valid, { syncDirectory: true });
}

export function readRetainedUpdate(home: string, id: string): HostUpdateOperation {
  hostUpdateOperationSchema.shape.id.parse(id);
  privatePath(join(home, 'updates'), true);
  privatePath(join(home, 'updates/retained'), true);
  const operation = hostUpdateOperationSchema.parse(
    readPrivateJson(join(home, 'updates/retained', `${id}.json`), HOST_UPDATE_RECORD_BYTES),
  );
  if (operation.id !== id || !hostUpdateTerminal(operation.phase))
    throw new Error('Invalid retained terminal update');
  return operation;
}
