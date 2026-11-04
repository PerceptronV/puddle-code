import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  initialisePrivateHome,
  privateDirectory,
  privatePath,
  readPrivateJson,
} from '@puddle/shared/node';
import { AtomicFileSlotsSync } from '../../../storage/atomic/sync.js';

export const HOST_MEMORY_LEDGER_BYTES = 16 * 1024 * 1024;
const uncertainIo = new Map<string, unknown>();
const sealWriters = new Map<string, AtomicFileSlotsSync>();
function homeKey(home: string): string {
  try {
    return realpathSync(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(home);
    throw error;
  }
}

/** Never retry descriptor-opening work after an indeterminate close in this process. */
export function memoryIo<T>(home: string, operation: () => T): T {
  const key = homeKey(home);
  if (uncertainIo.has(key)) throw uncertainIo.get(key);
  try {
    return operation();
  } catch (error) {
    const syscall = (error as NodeJS.ErrnoException).syscall;
    if (syscall === 'close' || syscall === 'closedir') uncertainIo.set(homeKey(home), error);
    throw error;
  }
}
const sealSchema = z
  .object({
    format: z.literal(1),
    instance: z.uuid(),
    capacity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    device: z.number().int().nonnegative(),
    inode: z.number().int().positive(),
  })
  .strict();
export type HostMemorySeal = z.infer<typeof sealSchema>;
export interface HostMemoryPaths {
  home: string;
  directory: string;
  database: string;
  seal: string;
}

export function memoryPaths(home: string, create = true): HostMemoryPaths | null {
  home = homeKey(home);
  const directory = join(home, 'runtime-claims');
  if (create) {
    initialisePrivateHome(home);
    privateDirectory(directory);
  } else {
    try {
      privatePath(home, true);
      privatePath(directory, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  return {
    home,
    directory,
    database: join(directory, 'managed-memory.sqlite'),
    seal: join(directory, 'managed-memory.seal'),
  };
}

export function memoryFile(file: string, maxBytes: number) {
  privatePath(file);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes)
    throw new Error('Unsafe or oversized host memory ledger file');
  return stat;
}

export function optionalMemoryFile(file: string, maxBytes: number) {
  try {
    return memoryFile(file, maxBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function readMemorySeal(paths: HostMemoryPaths): HostMemorySeal | null {
  if (!optionalMemoryFile(paths.seal, 4096)) return null;
  return sealSchema.parse(readPrivateJson(paths.seal, 4096));
}

/** Every ledger inode is permanent, including across purge. */
export function createMemoryFile(file: string): void {
  const fd = openSync(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  closeSync(fd);
}

export function writeMemorySeal(paths: HostMemoryPaths, value: HostMemorySeal): void {
  const json = JSON.stringify(sealSchema.parse(value)) + '\n';
  const existing = sealWriters.get(paths.directory);
  if (existing) {
    // Its pool retains uncertain descriptors/slots after a failed attempt.
    existing.write(paths.seal, json);
    sealWriters.delete(paths.directory);
    return;
  }
  const temporary = join(paths.directory, '.managed-memory-seal-0.tmp');
  const prior = optionalMemoryFile(temporary, 4096);
  if (prior) {
    // Caller holds initialisation/controller claims, proved zero grants and no
    // launches. Recover only a complete/partial copy of this exact unused seal.
    const fd = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      const data = Buffer.alloc(4097);
      let size = 0;
      for (;;) {
        const read = readSync(fd, data, size, data.length - size, null);
        size += read;
        if (!read || size === data.length) break;
      }
      const current = memoryFile(temporary, 4096);
      if (
        size > 4096 ||
        stat.dev !== prior.dev ||
        stat.ino !== prior.ino ||
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        !json.startsWith(data.subarray(0, size).toString('utf8'))
      )
        throw new Error('Unknown memory initialisation scratch file');
    } finally {
      closeSync(fd);
    }
    unlinkSync(temporary);
  }
  const writer = new AtomicFileSlotsSync({
    directory: paths.directory,
    prefix: 'managed-memory-seal',
    slots: 1,
    maxBytes: 4096,
    syncFile: true,
    syncDirectory: true,
  });
  sealWriters.set(paths.directory, writer);
  writer.write(paths.seal, json);
  sealWriters.delete(paths.directory);
}

/** Only first initialisation: released 0.3 hosts have no independent runtime directories. */
export function requireNoRuntimeLaunches(home: string): void {
  const root = join(home, 'runtimes');
  try {
    privatePath(root, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const directory = opendirSync(root);
  try {
    if (directory.readSync())
      throw new Error('Existing runtime launches prevent memory ledger initialisation');
  } finally {
    directory.closeSync();
  }
}

export function requireMemorySidecars(paths: HostMemoryPaths): void {
  optionalMemoryFile(`${paths.database}-journal`, HOST_MEMORY_LEDGER_BYTES + 1024 * 1024);
  for (const suffix of ['-wal', '-shm'])
    if (optionalMemoryFile(paths.database + suffix, HOST_MEMORY_LEDGER_BYTES))
      throw new Error('Unexpected host memory ledger WAL state');
}
