import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  AtomicSlotPool,
  atomicFileIdentity,
  requireAtomicFile,
  type AtomicFileIdentity,
  type AtomicFileOptions,
} from './pool.js';

/** Same fixed-slot ownership rules as AtomicFileSlots, for required synchronous state records. */
export class AtomicFileSlotsSync {
  private readonly pool: AtomicSlotPool;
  constructor(options: AtomicFileOptions) {
    this.pool = new AtomicSlotPool(options);
  }

  write(file: string, json: string): void {
    const slot = this.pool.reserve(json);
    const temporary = this.pool.path(slot);
    let owned: AtomicFileIdentity | undefined;
    let published = false;
    let reusable = true;
    let failure: { error: unknown } | undefined;
    const matches = () => requireAtomicFile(lstatSync(temporary), owned);
    const close = (fd: number) => {
      try {
        closeSync(fd);
      } catch (error) {
        this.pool.retain(slot);
        failure ??= { error };
      }
    };
    try {
      let fd: number;
      try {
        fd = openSync(temporary, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') reusable = false;
        throw error;
      }
      reusable = false;
      try {
        owned = atomicFileIdentity(fstatSync(fd));
        writeFileSync(fd, json);
        if (this.pool.options.syncFile) fsyncSync(fd);
      } catch (error) {
        failure = { error };
      } finally {
        close(fd);
      }
      if (failure) throw failure.error;
      matches();
      renameSync(temporary, file);
      published = true;
      reusable = true;
      if (this.pool.options.syncDirectory) {
        const directory = openSync(dirname(file), 'r');
        try {
          fsyncSync(directory);
        } catch (error) {
          failure ??= { error };
        } finally {
          close(directory);
        }
      }
    } catch (error) {
      failure ??= { error };
    } finally {
      if (owned && !published && !this.pool.isUncertain(slot)) {
        try {
          matches();
          unlinkSync(temporary);
          reusable = true;
        } catch (error) {
          failure ??= { error };
        }
      }
      if (reusable) this.pool.release(slot);
    }
    if (failure) throw failure.error;
  }
}
