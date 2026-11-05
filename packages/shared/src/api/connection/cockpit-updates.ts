import { z } from 'zod';
import { hostUpdateOperationSchema, hostUpdateTargetsSchema } from '../../installation/update.js';
import { hostUpdateCatalogueSchema } from '../../installation/catalogue.js';
import {
  hostUpdateFingerprintSchema,
  hostUpdateRecoveryStatusSchema,
  hostUpdateReferenceSchema,
  hostUpdateReviewSchema,
} from './host-updates.js';

/** Bounded online controls shared by cockpits and explicitly authorised maintenance devices. */
export const onlineHostUpdateRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prepare'), targets: hostUpdateTargetsSchema }).strict(),
  z.object({ action: z.literal('inspect'), reference: hostUpdateReferenceSchema }).strict(),
  z
    .object({
      action: z.literal('apply'),
      reference: hostUpdateReferenceSchema,
      fingerprint: hostUpdateFingerprintSchema,
      interruption_approval: hostUpdateFingerprintSchema.optional(),
    })
    .strict(),
  z.object({ action: z.literal('cancel'), reference: hostUpdateReferenceSchema }).strict(),
  z
    .object({
      action: z.literal('recover'),
      reference: hostUpdateReferenceSchema,
      strategy: z.enum(['verify-completion', 'continue']),
    })
    .strict(),
]);

/** Offline continuation requires the local/SSH cockpit's host authority. */
export const cockpitHostUpdateRequestSchema = z.discriminatedUnion('action', [
  ...onlineHostUpdateRequestSchema.options,
  z
    .object({ action: z.literal('continue-offline'), reference: hostUpdateReferenceSchema })
    .strict(),
]);

export const cockpitHostUpdateQuerySchema = z
  .object({ id: z.uuid().optional(), components: z.literal('1').optional() })
  .strict();

const operation = hostUpdateOperationSchema.shape;
export const cockpitHostUpdateOperationSchema = z
  .object({
    id: operation.id,
    revision: operation.revision,
    created_at: operation.created_at,
    updated_at: operation.updated_at,
    phase: operation.phase,
    targets: operation.targets,
    staged: z.boolean(),
    dispatched: z.boolean(),
    message: operation.message,
  })
  .strict();

/** Keep bounded impact and approval evidence, excluding private blocker target paths. */
export const cockpitHostUpdateReviewSchema = hostUpdateReviewSchema.extend({
  blockers: z.array(z.object({ code: z.string().min(1).max(64) }).strict()).max(32),
});

export const cockpitHostUpdateReplySchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      operation: cockpitHostUpdateOperationSchema.nullable(),
      review: cockpitHostUpdateReviewSchema.optional(),
      recovery: hostUpdateRecoveryStatusSchema.optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(['rejected', 'unavailable', 'unsupported', 'conflict', 'failed']),
      operation: cockpitHostUpdateOperationSchema.nullable(),
    })
    .strict(),
]);

export const cockpitHostUpdateStatusSchema = z
  .object({
    availability: z.enum(['ready', 'unavailable', 'upgrade_required']),
    /** Recorded operations do not establish current service health or adoption. */
    observation: z.enum(['live', 'recorded']).optional(),
    daemon_version: z.string().max(128).nullable(),
    capabilities: z
      .object({
        interruption_approval: z.boolean(),
        verify_completion: z.boolean(),
        continue_recovery: z.boolean(),
        offline_continuation: z.boolean().optional(),
      })
      .strict(),
    result: cockpitHostUpdateReplySchema.nullable(),
    catalogue: hostUpdateCatalogueSchema.optional(),
  })
  .strict();

export type CockpitHostUpdateRequest = z.infer<typeof cockpitHostUpdateRequestSchema>;
export type CockpitHostUpdateReply = z.infer<typeof cockpitHostUpdateReplySchema>;
export type CockpitHostUpdateStatus = z.infer<typeof cockpitHostUpdateStatusSchema>;
