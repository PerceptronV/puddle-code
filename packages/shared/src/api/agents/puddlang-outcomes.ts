import { z } from 'zod';

export const puddlangOutcomeOperationSchema = z.number().int().safe();
export const puddlangOutcomeActionSchema = z.enum(['read', 'discard']);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const terminalStatus = z.enum(['completed', 'failed', 'cancelled', 'interrupted']);
export const puddlangOutcomeDispositionSchema = z
  .object({
    action: puddlangOutcomeActionSchema,
    fingerprint,
    at: z.iso.datetime(),
  })
  .strict();
export const puddlangOutcomeSchema = z
  .object({
    operation_id: puddlangOutcomeOperationSchema,
    runtime_id: z.uuid(),
    turn: z.number().int().positive().safe(),
    status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted', 'unavailable']),
    retained: z.boolean(),
    consumed: z.boolean().nullable(),
    fingerprint: fingerprint.nullable(),
    disposition: puddlangOutcomeDispositionSchema.nullable(),
  })
  .strict();
export const puddlangOutcomesSchema = z
  .object({
    outcomes: z.array(puddlangOutcomeSchema).max(50),
    next_after: puddlangOutcomeOperationSchema.nullable(),
  })
  .strict();
export const puddlangOutcomeRequestSchema = z
  .object({
    action: puddlangOutcomeActionSchema,
    fingerprint,
  })
  .strict();
export const puddlangOutcomeResponseSchema = z
  .object({
    outcome: puddlangOutcomeSchema,
    // Explicit reads only. Native references and prompts are never projected here.
    result: z
      .object({
        status: terminalStatus,
        reply: z
          .string()
          .max(256 * 1024)
          .optional(),
        error: z.string().max(4096).optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type PuddlangOutcome = z.infer<typeof puddlangOutcomeSchema>;
export type PuddlangOutcomeRequest = z.infer<typeof puddlangOutcomeRequestSchema>;
export type PuddlangOutcomeResponse = z.infer<typeof puddlangOutcomeResponseSchema>;
