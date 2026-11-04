import { z } from 'zod';
import {
  hostUpdateCheckpointReferenceSchema,
  hostUpdateCheckpointSchema,
  HOST_UPDATE_CHECKPOINT_OWNERS,
} from './checkpoint.js';
import { hostStageRecordSchema } from './stage.js';

/** Private observation; compatible candidates may add metadata which older workers ignore. */
export const hostUpdateAdoptionSchema = hostUpdateCheckpointReferenceSchema
  .extend({
    format: z.literal(1),
    nonce: z.uuid(),
    checkpoint: z.string().regex(/^[0-9a-f]{64}$/),
    stage: z.string().regex(/^[0-9a-f]{64}$/),
    observed_at: z.number().int().nonnegative().safe(),
    daemon: hostUpdateCheckpointSchema.shape.daemon
      .extend({
        port: z.number().int().min(1).max(65535),
        protocol: hostStageRecordSchema.shape.protocol,
        release_path: z.string().min(1).max(4096),
        node_path: z.string().min(1).max(4096),
        entry_path: z.string().min(1).max(4096),
        controller: hostUpdateCheckpointSchema.shape.daemon.shape.controller.strip(),
      })
      .strip(),
    owners: z
      .array(
        z
          .object({
            runtime_id: z.uuid(),
            event_cursor: z.number().int().nonnegative().safe(),
            state: z.enum(['running', 'exited', 'failed']),
          })
          .strip(),
      )
      .max(HOST_UPDATE_CHECKPOINT_OWNERS),
  })
  .strip()
  .refine(
    (record) =>
      new Set(record.owners.map((owner) => owner.runtime_id)).size === record.owners.length,
    'Duplicate adopted owner',
  );
export type HostUpdateAdoption = z.infer<typeof hostUpdateAdoptionSchema>;
