import { z } from 'zod';
import { puddlangOperationSchema } from '../../api/agents/puddlang.js';
import { huddleComponentSchema } from '../../api/huddle/components.js';
import { huddleRevisionSchema } from '../../api/huddle/events.js';
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

export const huddleWorkerActionSchema = z.discriminatedUnion('kind', [
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
  action: huddleWorkerActionSchema,
});
export type HuddleWorkerRequest = z.infer<typeof huddleWorkerRequestSchema>;
export const huddleWorkerMessageSchema = z.discriminatedUnion('type', [
  huddleWorkerRequestSchema,
  z.strictObject({ type: z.literal('finished'), outputs: huddleNamedValuesSchema }),
  z.strictObject({ type: z.literal('failed'), error: z.string().min(1).max(4096) }),
]);
export const huddleWorkerInputSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('start'), job: huddleWorkerJobSchema }),
  z.strictObject({ type: z.literal('reply'), id: z.uuid(), value: huddleJsonSchema }),
  z.strictObject({ type: z.literal('reject'), id: z.uuid(), error: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal('cancel'), reason: z.string().min(1).max(4096) }),
]);
export type HuddleWorkerInput = z.infer<typeof huddleWorkerInputSchema>;
