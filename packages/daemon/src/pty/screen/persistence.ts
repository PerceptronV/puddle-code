import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AtomicFileSlots } from '../../storage/atomic/slots.js';
import { SCREEN_LIMITS } from './limits.js';

/** Fixed names also bound abandoned scratch files across store/process replacements. */
export function screenScratchPath(root: string, slot: number): string {
  return join(root, `.screen-write-${slot}.tmp`);
}

/** One pool across all keys, including the legacy daemon's unbounded session set. */
export class ScreenSnapshotFiles {
  private readonly slots: AtomicFileSlots;

  constructor(root: string) {
    this.slots = new AtomicFileSlots({
      directory: root,
      prefix: 'screen-write',
      slots: SCREEN_LIMITS.scratchFiles,
      maxBytes: SCREEN_LIMITS.fileBytes,
    });
  }

  async save(file: string, json: string, current: () => boolean): Promise<boolean> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    return this.slots.write(file, json, current);
  }
}
