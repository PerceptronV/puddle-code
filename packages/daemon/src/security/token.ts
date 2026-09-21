import { z } from 'zod';
import { atomicPrivateJson, readPrivateJson, secret } from '@puddle/shared/node';
import type { PuddlePaths } from '../paths.js';

const authorityFile = z.object({
  migration: z.literal(18),
  master: z.string().regex(/^[a-f0-9]{64}$/),
});

/** The old distributed bearer is replaced atomically with the migration marker.
 * This host-only recovery credential is never accepted by the HTTP/WS surface. */
export function ensureToken(paths: PuddlePaths): string {
  try {
    const parsed = authorityFile.safeParse(readPrivateJson(paths.tokenFile));
    if (parsed.success) return parsed.data.master;
  } catch (err) {
    if (!(err instanceof SyntaxError) && (err as NodeJS.ErrnoException).code !== 'ENOENT')
      throw err;
  }
  const master = secret();
  atomicPrivateJson(paths.tokenFile, { migration: 18, master });
  return master;
}
