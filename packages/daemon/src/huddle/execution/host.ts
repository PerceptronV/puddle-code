import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicPrivateJson, readPrivateJson } from '@puddle/shared/node';
import { acquireHostClaim } from '../../security/claims.js';

const identity = z.strictObject({ format: z.literal(1), id: z.uuid() });

/** Installation-local event identity; never an authentication credential. */
export function huddleHostIdentity(home: string): string {
  const claim = acquireHostClaim(home, 'huddle-host-identity');
  try {
    const path = join(home, 'huddle-host.json');
    try {
      return identity.parse(readPrivateJson(path, 1024)).id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const record = { format: 1, id: randomUUID() };
    atomicPrivateJson(path, record, { syncDirectory: true });
    return record.id;
  } finally {
    claim.release();
  }
}
