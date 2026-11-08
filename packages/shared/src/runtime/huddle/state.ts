import { z } from 'zod';
import { huddleEventSchema, huddleRevisionSchema } from '../../api/huddle/events.js';
import { huddleJsonSchema, huddleKeySchema } from '../../api/huddle/values.js';
import { huddleDefinitionSchema } from '../../api/huddle/definitions.js';

/** Private owner state; these schemas do not extend the agent/terminal IPC contract. */
export const huddleLedgerIdentitySchema = huddleEventSchema.shape.scope;
export type HuddleLedgerIdentity = z.infer<typeof huddleLedgerIdentitySchema>;

export const huddleInboxRecordSchema = z.strictObject({
  event: huddleEventSchema,
  nextCursor: huddleJsonSchema,
  state: z.enum(['pending', 'accepted', 'cancelled']),
});
export type HuddleInboxRecord = z.infer<typeof huddleInboxRecordSchema>;

export const huddleExecutionRecordSchema = z.strictObject({
  id: z.uuid(),
  eventKey: huddleRevisionSchema,
  revision: huddleRevisionSchema,
  activationId: z.uuid().optional(),
  state: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
  limits: huddleDefinitionSchema.shape.execution,
  acceptedAt: z.number().int().nonnegative().safe(),
  deadline: z.number().int().nonnegative().safe(),
  turns: z.number().int().nonnegative(),
  spawns: z.number().int().nonnegative(),
  invocations: z.number().int().nonnegative(),
  error: z.string().max(4096).optional(),
});
export type HuddleExecutionRecord = z.infer<typeof huddleExecutionRecordSchema>;

export const huddleInvocationRecordSchema = z
  .strictObject({
    id: z.uuid(),
    executionId: z.uuid(),
    revision: huddleRevisionSchema,
    node: huddleKeySchema,
    activation: z.string().min(1).max(256),
    iteration: z.number().int().min(0).max(1000),
    lastEmission: z.number().int().nonnegative().safe().default(0),
    inputs: huddleJsonSchema,
    state: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
    result: huddleJsonSchema.optional(),
    error: z.string().max(4096).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.state === 'completed') !== (value.result !== undefined))
      ctx.addIssue({ code: 'custom', message: 'Only completed invocations retain a result' });
    if (['pending', 'running', 'completed'].includes(value.state) && value.error !== undefined)
      ctx.addIssue({ code: 'custom', message: 'Healthy invocations cannot retain a failure' });
  });
export type HuddleInvocationRecord = z.infer<typeof huddleInvocationRecordSchema>;

export const huddleOperationRecordSchema = z
  .strictObject({
    id: z.uuid(),
    invocationId: z.uuid(),
    executionId: z.uuid(),
    kind: z.enum(['spawn', 'ask', 'stop', 'resume', 'restart', 'file-write', 'readout']),
    target: huddleJsonSchema,
    input: huddleJsonSchema,
    state: z.enum(['prepared', 'dispatched', 'completed', 'failed', 'unknown', 'cancelled']),
    consumed: z.boolean(),
    result: huddleJsonSchema.optional(),
    error: z.string().max(4096).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.state === 'prepared' || value.state === 'cancelled') && value.consumed)
      ctx.addIssue({ code: 'custom', message: 'Unsent operations cannot be marked consumed' });
    if (['dispatched', 'completed', 'failed', 'unknown'].includes(value.state) && !value.consumed)
      ctx.addIssue({ code: 'custom', message: 'Attempted operations retain dispatch consumption' });
    if (['completed', 'failed'].includes(value.state) !== (value.result !== undefined))
      ctx.addIssue({ code: 'custom', message: 'Only settled operations retain a result' });
    if (value.state !== 'unknown' && value.error !== undefined)
      ctx.addIssue({
        code: 'custom',
        message: 'An observation error belongs to an unknown outcome',
      });
  });
export type HuddleOperationRecord = z.infer<typeof huddleOperationRecordSchema>;

export const huddleEmissionRecordSchema = z.strictObject({
  invocationId: z.uuid(),
  executionId: z.uuid(),
  revision: huddleRevisionSchema,
  node: huddleKeySchema,
  sequence: z.number().int().positive().safe(),
  port: huddleKeySchema,
  value: huddleJsonSchema,
  kind: z.enum(['event', 'completion']),
  state: z.enum(['pending', 'routed', 'cancelled']),
});
export type HuddleEmissionRecord = z.infer<typeof huddleEmissionRecordSchema>;
