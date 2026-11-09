import { z } from 'zod';
import { puddlangOperationSchema } from '../../api/agents/puddlang.js';
import { huddleTriggerCursorSchema } from './triggers/custom.js';
import { huddleTriggerEmissionSchema, huddleTriggerHealthSchema } from '../../api/huddle/events.js';
import { huddleComponentSchema } from '../../api/huddle/components.js';
import {
  huddleRevisionSchema,
  huddleDeliverySchema,
  huddleDeliveryResultSchema,
} from '../../api/huddle/events.js';
import {
  HUDDLE_LIMITS,
  huddleJsonSchema,
  huddleKeySchema,
  huddleRelativePathSchema,
} from '../../api/huddle/values.js';

export const HUDDLE_WORKER_LIMITS = {
  pending: 64,
  requests: 4096,
  logBytes: 1024 * 1024,
  heapMiB: 128,
  subscriptionRequestsPerSecond: 64,
} as const;
export const huddleNamedValuesSchema = z
  .record(huddleKeySchema, huddleJsonSchema)
  .refine(
    (value) =>
      Object.keys(value).length <= HUDDLE_LIMITS.ports && huddleJsonSchema.safeParse(value).success,
  );
const source = z
  .string()
  .max(HUDDLE_LIMITS.fileBytes)
  .refine((text) => new TextEncoder().encode(text).length <= HUDDLE_LIMITS.fileBytes);
export const huddleWorkerJobSchema = z.strictObject({
  invocationId: z.uuid(),
  revision: huddleRevisionSchema,
  node: huddleKeySchema,
  readout: z
    .strictObject({ delivery: huddleDeliverySchema, mode: z.enum(['deliver', 'observe']) })
    .optional(),
  manifest: huddleRelativePathSchema,
  component: huddleComponentSchema,
  files: z
    .record(huddleRelativePathSchema, source)
    .refine(
      (files) =>
        Object.keys(files).length <= HUDDLE_LIMITS.files &&
        Object.values(files).reduce(
          (total, text) => total + new TextEncoder().encode(text).length,
          0,
        ) <= HUDDLE_LIMITS.bundleBytes,
    ),
  inputs: huddleNamedValuesSchema,
  parameters: huddleNamedValuesSchema,
  bindings: z
    .record(huddleKeySchema, z.string().min(1).max(4096))
    .refine((value) => Object.keys(value).length <= HUDDLE_LIMITS.ports),
});
export type HuddleWorkerJob = z.infer<typeof huddleWorkerJobSchema>;
export const huddleTriggerWorkerJobSchema = huddleWorkerJobSchema
  .omit({
    invocationId: true,
    inputs: true,
    readout: true,
  })
  .extend({ subscriptionId: z.uuid(), cursor: huddleTriggerCursorSchema });
export type HuddleTriggerWorkerJob = z.infer<typeof huddleTriggerWorkerJobSchema>;

export const huddleWorkerActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('trigger-emit'), emission: huddleTriggerEmissionSchema }),
  z.strictObject({ kind: z.literal('trigger-health'), health: huddleTriggerHealthSchema }),
  z.strictObject({ kind: z.literal('trigger-checkpoint'), cursor: huddleTriggerCursorSchema }),
  z.strictObject({ kind: z.literal('readout-result'), result: huddleDeliveryResultSchema }),
  z.strictObject({
    kind: z.literal('operation'),
    operation: puddlangOperationSchema.refine(
      (operation) => huddleJsonSchema.safeParse(operation).success,
    ),
  }),
  z.strictObject({
    kind: z.literal('emit'),
    sequence: z.number().int().positive().safe(),
    port: huddleKeySchema,
    value: huddleJsonSchema,
  }),
]);
export type HuddleWorkerAction = z.infer<typeof huddleWorkerActionSchema>;
export const huddleWorkerRequestSchema = z.strictObject({
  type: z.literal('request'),
  id: z.uuid(),
  sequence: z.number().int().positive().safe().optional(),
  action: huddleWorkerActionSchema,
});
export type HuddleWorkerRequest = z.infer<typeof huddleWorkerRequestSchema>;
export const huddleWorkerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('opened') }),
  huddleWorkerRequestSchema,
  z.strictObject({ type: z.literal('finished'), outputs: huddleNamedValuesSchema }),
  z.strictObject({ type: z.literal('failed'), error: z.string().min(1).max(4096) }),
]);
const workerSecrets = z
  .record(huddleKeySchema, z.string().min(1).max(4096))
  .refine(
    (values) =>
      Object.keys(values).length <= 16 &&
      new TextEncoder().encode(JSON.stringify(values)).length <= 64 * 1024,
  );
export const huddleWorkerInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('subscribe'),
    job: huddleTriggerWorkerJobSchema,
    secrets: workerSecrets.optional(),
  }),
  z.strictObject({
    type: z.literal('start'),
    job: huddleWorkerJobSchema,
    secrets: workerSecrets.optional(),
  }),
  z.strictObject({ type: z.literal('reply'), id: z.uuid(), value: huddleJsonSchema }),
  z.strictObject({ type: z.literal('reject'), id: z.uuid(), error: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal('cancel'), reason: z.string().min(1).max(4096) }),
]);
export type HuddleWorkerInput = z.infer<typeof huddleWorkerInputSchema>;
