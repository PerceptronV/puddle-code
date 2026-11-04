import { lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  AtomicSlotPool,
  atomicFileIdentity,
  requireAtomicFile,
  type AtomicFileIdentity,
  type AtomicFileOptions,
} from './pool.js';

/** Fixed exclusive scratch identities; unresolved ownership/close/cleanup pins capacity. */
export class AtomicFileSlots {
  private readonly pool: AtomicSlotPool;
  constructor(options: AtomicFileOptions) {
    this.pool = new AtomicSlotPool(options);
  }

  async write(file: string, json: string, current = () => true): Promise<boolean> {
    const slot = this.pool.reserve(json);
    const temporary = this.pool.path(slot);
    let owned: AtomicFileIdentity | undefined;
    let published = false;
    let reusable = true;
    let failure: { error: unknown } | undefined;
    const matches = async () => {
      const stat = await lstat(temporary);
      requireAtomicFile(stat, owned);
    };
    const close = async (handle: FileHandle) => {
      try {
        await handle.close();
      } catch (error) {
        this.pool.retain(slot, handle);
        failure ??= { error };
      }
    };
    try {
      const handle = await open(temporary, 'wx', 0o600).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') reusable = false;
        throw error;
      });
      reusable = false;
      try {
        const stat = await handle.stat();
        owned = atomicFileIdentity(stat);
        await handle.writeFile(json);
        if (this.pool.options.syncFile) await handle.sync();
      } catch (error) {
        failure = { error };
      } finally {
        await close(handle);
      }
      if (failure) throw failure.error;
      await matches();
      if (current()) {
        await rename(temporary, file);
        published = true;
        reusable = true;
        if (this.pool.options.syncDirectory) {
          const directory = await open(dirname(file), 'r');
          try {
            await directory.sync();
          } catch (error) {
            failure ??= { error };
          } finally {
            await close(directory);
          }
        }
      }
    } catch (error) {
      failure ??= { error };
    } finally {
      // An uncertain descriptor must retain its inode as well as its slot.
      if (owned && !published && !this.pool.isUncertain(slot)) {
        try {
          await matches();
          await unlink(temporary);
          reusable = true;
        } catch (error) {
          failure ??= { error };
        }
      }
      if (reusable && !this.pool.isUncertain(slot)) this.pool.release(slot);
    }
    if (failure) throw failure.error;
    return published;
  }
}
