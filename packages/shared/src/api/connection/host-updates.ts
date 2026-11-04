import { z } from 'zod';
import { hostUpdateOperationSchema, hostUpdateTargetsSchema } from '../../installation/update.js';
import { hostStageReceiptSchema, hostStageRecordSchema } from '../../installation/stage.js';

export const hostUpdateReferenceSchema = z
  .object({
    id: hostUpdateOperationSchema.shape.id,
    revision: hostUpdateOperationSchema.shape.revision,
  })
  .strict();
export const hostUpdateFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
const reference = hostUpdateReferenceSchema;
const fingerprint = hostUpdateFingerprintSchema;

/** Private local/SSH control only; never a remote-connector or browser command surface. */
export const hostUpdateCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('status'),
      id: z.uuid().optional(),
      /** Fresh private worker observation; never authorises activation. */
      adoption_nonce: z.uuid().optional(),
      /** Recorded continuation metadata, capability-detected from application 25.12. */
      include_recovery: z.literal(true).optional(),
    })
    .strict()
    .refine(
      (command) => !command.adoption_nonce || command.id !== undefined,
      'Adoption inspection requires an exact operation',
    ),
  z.object({ action: z.literal('begin'), targets: hostUpdateTargetsSchema }).strict(),
  z.object({ action: z.literal('stage'), reference, receipt: hostStageReceiptSchema }).strict(),
  z
    .object({
      action: z.literal('recover'),
      reference,
      strategy: z.enum(['verify-completion', 'continue']),
    })
    .strict(),
  z
    .object({
      action: z.literal('inspect'),
      reference,
      cockpit: hostStageRecordSchema.shape.protocol,
    })
    .strict(),
  z
    .object({
      action: z.literal('apply'),
      reference,
      cockpit: hostStageRecordSchema.shape.protocol,
      fingerprint,
      /** Explicit consent to the exact reviewed daemon-owned interruption inventory (25.10). */
      interruption_approval: fingerprint.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('cancel'),
      reference,
      reason: z.enum(['cancelled', 'staging_failed']),
    })
    .strict(),
]);

/** A blocked interruption review may offer exact evidence for a separate confirmation. */
export const hostUpdateReviewSchema = z
  .object({
    fingerprint: fingerprint.nullable(),
    can_apply: z.boolean(),
    /** Never makes can_apply true; only a matching explicit apply approval permits interruption. */
    interruption_fingerprint: fingerprint.optional(),
    blockers: z
      .array(z.object({ code: z.string().min(1).max(64), target: z.string().max(4096) }).strict())
      .max(32),
    more_blockers: z.number().int().nonnegative().safe(),
    affected: z
      .object({
        terminals: z.number().int().nonnegative().safe(),
        notebooks: z.number().int().nonnegative().safe(),
        compilation: z.number().int().nonnegative().safe(),
        programmes: z.number().int().nonnegative().safe(),
      })
      .strict(),
  })
  .strict();

export const hostUpdateRecoveryStatusSchema = z
  .object({
    id: z.uuid(),
    requested_revision: hostUpdateOperationSchema.shape.revision,
    revision: hostUpdateOperationSchema.shape.revision,
    /** Durable consumption, not a claim that the worker is still running or completed. */
    consumed: z.boolean(),
  })
  .strict();

export const hostUpdateReplySchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      operation: hostUpdateOperationSchema.nullable(),
      created: z.boolean().optional(),
      review: hostUpdateReviewSchema.optional(),
      recovery: hostUpdateRecoveryStatusSchema.optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(['rejected', 'unavailable', 'unsupported', 'conflict', 'failed']),
      operation: hostUpdateOperationSchema.nullable(),
    })
    .strict(),
]);
export const hostUpdateControlRequestSchema = z
  .object({ t: z.literal('host-update'), request_id: z.uuid(), command: hostUpdateCommandSchema })
  .strict();
export const hostUpdateControlResponseSchema = z
  .object({
    t: z.literal('host-update-result'),
    request_id: z.uuid(),
    result: hostUpdateReplySchema,
  })
  .strict();
export type HostUpdateCommand = z.infer<typeof hostUpdateCommandSchema>;
export type HostUpdateReply = z.infer<typeof hostUpdateReplySchema>;
export type HostUpdateReview = z.infer<typeof hostUpdateReviewSchema>;
