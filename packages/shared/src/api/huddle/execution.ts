import { z } from 'zod';
import { sessionId } from '../common.js';
import { huddleJsonSchema, huddleKeySchema, HUDDLE_LIMITS } from './values.js';
import { huddleRevisionSchema } from './events.js';
import {
  huddleCustomTriggerViewSchema,
  HUDDLE_CUSTOM_TRIGGER_LIMIT,
} from '../../runtime/huddle/triggers/custom.js';
import {
  huddleExecutionRecordSchema,
  huddleInvocationRecordSchema,
  huddleOperationRecordSchema,
} from '../../runtime/huddle/state.js';

const ordinal = z.number().int().nonnegative().safe();
export const huddleRuntimeTargetSchema = z.strictObject({
  runtimeId: z.uuid(),
  incarnation: z.uuid(),
});
export const huddleCommandTargetSchema = huddleRuntimeTargetSchema.extend({
  generation: ordinal,
  activationId: z.uuid().nullable(),
});
export const huddleRuntimeInspectionSchema = z.strictObject({
  session_id: sessionId,
  unresolved: z.boolean(),
  recovery: z.strictObject({ owner: huddleRuntimeTargetSchema }).optional(),
  owner: z
    .discriminatedUnion('connected', [
      z.strictObject({
        connected: z.literal(false),
        identity: huddleRuntimeTargetSchema,
        build: z.string().max(128),
      }),
      z.strictObject({
        connected: z.literal(true),
        target: huddleCommandTargetSchema,
        build: z.string().max(128),
        lifetime: z.enum(['service', 'host_session']),
        lifecycle: z.enum(['stopped', 'armed', 'interrupted']),
        auto_start: z.boolean().optional(),
        trigger_inspection: z.literal(true).optional(),
        executing: z.boolean(),
        stopping: z.boolean(),
        failure: z.string().max(4096).nullable(),
        readout_observation: z.literal(true).optional(),
        custom_triggers: z
          .array(huddleCustomTriggerViewSchema)
          .max(HUDDLE_CUSTOM_TRIGGER_LIMIT)
          .optional(),
      }),
    ])
    .nullable(),
});
const variables = z
  .record(huddleKeySchema, huddleJsonSchema)
  .refine(
    (value) =>
      Object.keys(value).length <= HUDDLE_LIMITS.ports && huddleJsonSchema.safeParse(value).success,
  );
/** Start admits captured saved bytes; it never saves a browser draft. */
export const huddleStartSchema = z.strictObject({
  expected_digest: huddleRevisionSchema,
  variables,
});
export const huddleRecoverSchema = z.strictObject({ owner: huddleRuntimeTargetSchema });
export type HuddleRecover = z.infer<typeof huddleRecoverSchema>;
export const huddleApplySchema = huddleStartSchema.extend({ target: huddleCommandTargetSchema });
export const huddleLifecycleCommandSchema = z.strictObject({ target: huddleCommandTargetSchema });
export const huddleAutoStartSchema = huddleLifecycleCommandSchema.extend({
  expected: z.boolean(),
  enabled: z.boolean(),
});
export type HuddleAutoStart = z.infer<typeof huddleAutoStartSchema>;
export const huddleRunSchema = huddleLifecycleCommandSchema.extend({
  node: huddleKeySchema,
  event_id: z.uuid(),
  data: huddleJsonSchema,
});
export const huddleRunAcceptedSchema = z.strictObject({
  executionId: z.uuid(),
  duplicate: z.boolean(),
});
export const huddleStoppedSchema = z.strictObject({ stopped: z.literal(true) });
export const huddleReadoutObserveSchema = huddleLifecycleCommandSchema.extend({
  operation_id: z.uuid(),
});
export const huddleReadoutObserveAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  operation_id: z.uuid(),
});
const historyRequest = {
  owner: huddleRuntimeTargetSchema,
  include_readout_observation: z.literal(true).optional(),
};
export const huddleHistoryRequestSchema = z.discriminatedUnion('collection', [
  z.strictObject({
    ...historyRequest,
    collection: z.literal('executions'),
    after: ordinal,
    parent: huddleRevisionSchema.optional(),
  }),
  z.strictObject({
    ...historyRequest,
    collection: z.literal('invocations'),
    after: ordinal,
    parent: z.uuid(),
  }),
  z.strictObject({
    ...historyRequest,
    collection: z.literal('operations'),
    after: ordinal,
    parent: z.uuid(),
  }),
]);
// Explicit projections: new private ledger fields never become public automatically.
const execution = huddleExecutionRecordSchema.pick({
  id: true,
  revision: true,
  activationId: true,
  state: true,
  acceptedAt: true,
  deadline: true,
  turns: true,
  spawns: true,
  invocations: true,
  error: true,
});
const invocation = z.strictObject(huddleInvocationRecordSchema.shape).pick({
  id: true,
  executionId: true,
  revision: true,
  node: true,
  iteration: true,
  state: true,
  inputs: true,
  result: true,
  error: true,
});
const operation = z
  .strictObject(huddleOperationRecordSchema.shape)
  .pick({
    id: true,
    invocationId: true,
    executionId: true,
    kind: true,
    state: true,
    consumed: true,
    result: true,
    error: true,
  })
  .extend({ readout_observation: z.literal(true).optional() });
export const huddleExecutionViewSchema = execution.strip();
export const huddleInvocationViewSchema = invocation.strip();
export const huddleOperationViewSchema = operation.strip();
const page = { owner: huddleRuntimeTargetSchema, next: ordinal };
export const huddleHistoryPageSchema = z.discriminatedUnion('collection', [
  z.strictObject({
    ...page,
    collection: z.literal('executions'),
    records: z.array(z.strictObject({ ordinal, record: execution })).max(256),
  }),
  z.strictObject({
    ...page,
    collection: z.literal('invocations'),
    records: z.array(z.strictObject({ ordinal, record: invocation })).max(256),
  }),
  z.strictObject({
    ...page,
    collection: z.literal('operations'),
    records: z.array(z.strictObject({ ordinal, record: operation })).max(256),
  }),
]);
export type HuddleRuntimeInspection = z.infer<typeof huddleRuntimeInspectionSchema>;
export type HuddleCommandTarget = z.infer<typeof huddleCommandTargetSchema>;
export type HuddleRunAccepted = z.infer<typeof huddleRunAcceptedSchema>;
export type HuddleStart = z.infer<typeof huddleStartSchema>;
export type HuddleApply = z.infer<typeof huddleApplySchema>;
export type HuddleLifecycleCommand = z.infer<typeof huddleLifecycleCommandSchema>;
export type HuddleRun = z.infer<typeof huddleRunSchema>;
export type HuddleReadoutObserve = z.infer<typeof huddleReadoutObserveSchema>;
export type HuddleHistoryRequest = z.infer<typeof huddleHistoryRequestSchema>;
export type HuddleHistoryPage = z.infer<typeof huddleHistoryPageSchema>;
