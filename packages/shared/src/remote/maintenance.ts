import { z } from 'zod';
import { remoteAccountSchema, remoteIdSchema, remotePeerSchema } from './protocol.js';

/** Host-derived Noise identity and exact grant generation; never browser-selected. */
export const remoteMaintenanceClaimSchema = z
  .object({
    device: remoteIdSchema,
    peer: remotePeerSchema,
    account: remoteAccountSchema,
    host: remoteIdSchema,
    grant: remoteIdSchema,
  })
  .strict();
export type RemoteMaintenanceClaim = z.infer<typeof remoteMaintenanceClaimSchema>;
