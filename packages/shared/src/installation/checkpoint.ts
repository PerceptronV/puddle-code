import { z } from 'zod';
import { runtimeControllerSchema } from '../runtime/storage.js';
import { runtimeIdentitySchema, runtimeStateSchema } from '../runtime/protocol.js';
import { huddleIdSchema } from '../api/huddle/values.js';
import { huddleRuntimeCapabilitiesSchema } from '../runtime/huddle/capabilities.js';

export const HOST_UPDATE_CHECKPOINT_OWNERS = 4096;
export const HOST_UPDATE_CHECKPOINT_BYTES = 8 * 1024 * 1024;

/** Accepted operation identity; neither a release receipt nor client approval alone suffices. */
export const hostUpdateCheckpointReferenceSchema = z
  .object({
    operation_id: z.uuid(),
    dispatch_id: z.uuid(),
    preflight: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** Private daemon shutdown evidence, written before releasing controller ownership. */
export const hostUpdateCheckpointSchema = hostUpdateCheckpointReferenceSchema
  .extend({
    format: z.literal(1),
    captured_at: z.number().int().nonnegative().safe(),
    daemon: z
      .object({
        pid: z.number().int().positive().safe(),
        version: z.string().min(1).max(128),
        controller: runtimeControllerSchema.pick({ id: true, epoch: true }).strip(),
        schema_version: z.number().int().nonnegative().safe(),
      })
      .strip(),
    owners: z
      .array(
        z
          .object({
            identity: runtimeIdentitySchema.strip(),
            build: runtimeStateSchema.shape.build,
            protocol: runtimeStateSchema.shape.protocol,
            release_path: runtimeIdentitySchema.shape.canonical_worktree_path,
            launch_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
            event_cursor: z.number().int().min(-1).safe(),
            state: z.enum(['prepared', 'running', 'exited', 'failed', 'interrupted']),
            // Absence is historical ordinary ownership, never inferred huddle support.
            huddle: z
              .strictObject({
                id: huddleIdSchema,
                capabilities: huddleRuntimeCapabilitiesSchema,
              })
              .optional(),
          })
          .strip(),
      )
      .max(HOST_UPDATE_CHECKPOINT_OWNERS),
  })
  .strip()
  .refine(
    (record) =>
      new Set(record.owners.map((owner) => owner.identity.runtime_id)).size ===
      record.owners.length,
    'Duplicate checkpoint owner',
  );

export type HostUpdateCheckpointReference = z.infer<typeof hostUpdateCheckpointReferenceSchema>;
export type HostUpdateCheckpoint = z.infer<typeof hostUpdateCheckpointSchema>;
