import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { SCREEN_LIMITS } from './limits.js';

/** A fixed read limit remains effective if a file grows after the initial stat. */
export async function readScreenFile(
  file: string,
  beforeRead?: () => Promise<void>,
): Promise<string> {
  // A substituted FIFO must not block before fstat can reject the descriptor.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > SCREEN_LIMITS.fileBytes)
      throw new Error('Terminal snapshot file exceeds its capacity or is not regular');
    await beforeRead?.();
    const buffer = Buffer.alloc(Math.min(stat.size + 1, SCREEN_LIMITS.fileBytes + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > stat.size) throw new Error('Terminal snapshot changed while being read');
    return buffer.toString('utf8', 0, offset);
  } finally {
    await handle.close();
  }
}
