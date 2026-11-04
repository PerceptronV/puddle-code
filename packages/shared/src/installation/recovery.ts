import { z } from 'zod';
import { hostUpdateWorkerSchema, hostUpdateWorkerLifetimeSchema } from './worker.js';
import { hostUpdateCheckpointSchema } from './checkpoint.js';

const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const revision = z.number().int().positive().safe();

/** Private one-shot recovery dispatch, pinned independently of the failed worker. */
export const hostUpdateRecoveryJobSchema = z
  .object({
    format: z.literal(1),
    id: z.uuid(),
    operation_id: z.uuid(),
    requested_revision: revision,
    revision,
    original_dispatch_id: z.uuid(),
    original_worker_id: z.uuid(),
    preflight: fingerprint,
    original_worker_digest: fingerprint,
    actions_digest: fingerprint,
    /** New explicit connector start after confirmed loss, bound to its selected service/build. */
    connector_restart: fingerprint.optional(),
    /** Explicit fresh attempt after confirmed daemon loss, bound to current storage and ownership. */
    daemon_restart: z
      .object({
        fingerprint,
        database_schema_version: hostUpdateCheckpointSchema.shape.daemon.shape.schema_version,
        owners: hostUpdateCheckpointSchema.shape.owners,
      })
      .strict()
      .refine(
        (record) =>
          new Set(record.owners.map(({ identity }) => identity.runtime_id)).size ===
          record.owners.length,
        'Duplicate restart runtime',
      )
      .optional(),
    service: z
      .object(hostUpdateWorkerSchema.shape)
      .pick({
        kind: true,
        name: true,
        domain: true,
        release_path: true,
        node_path: true,
        entry_path: true,
        installer_path: true,
      })
      .strict(),
  })
  .strict()
  .refine(
    (job) => job.revision === job.requested_revision + 1,
    'Recovery dispatch must fence its requested revision',
  );

export const hostUpdateRecoveryAttemptSchema = z
  .object({
    job: hostUpdateRecoveryJobSchema,
    /** Written before any component mutation, while the recovery worker holds execution. */
    execution: z
      .object({
        id: z.uuid(),
        process_group: hostUpdateWorkerLifetimeSchema.shape.process_group,
      })
      .strict()
      .nullable(),
  })
  .strict();

export const HOST_UPDATE_RECOVERY_ATTEMPTS = 8;
export const HOST_UPDATE_RECOVERY_BYTES = 256 * 1024;
export const hostUpdateRecoveryLedgerSchema = z
  .object({
    format: z.literal(1),
    attempts: z.array(hostUpdateRecoveryAttemptSchema).max(HOST_UPDATE_RECOVERY_ATTEMPTS),
  })
  .strict()
  .superRefine(({ attempts }, context) => {
    const ids = new Set<string>();
    let previous = 0;
    for (const { job } of attempts) {
      if (ids.has(job.id) || job.requested_revision < previous)
        context.addIssue({
          code: 'custom',
          message: 'Recovery attempts must have unique identities and ordered revisions',
        });
      ids.add(job.id);
      previous = job.revision;
    }
  });

export type HostUpdateRecoveryJob = z.infer<typeof hostUpdateRecoveryJobSchema>;
export type HostUpdateRecoveryAttempt = z.infer<typeof hostUpdateRecoveryAttemptSchema>;
export type HostUpdateRecoveryLedger = z.infer<typeof hostUpdateRecoveryLedgerSchema>;
