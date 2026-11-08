import { z } from 'zod';
import { huddleComponentSchema } from '../../api/huddle/components.js';
import { huddleRevisionSchema } from '../../api/huddle/events.js';
import {
  HUDDLE_LIMITS,
  huddleJsonSchema,
  huddleKeySchema,
  huddleRelativePathSchema,
} from '../../api/huddle/values.js';
import { huddleNamedValuesSchema } from './worker.js';

export const HUDDLE_REVISION_LIMITS = {
  recordBytes: 32 * 1024 * 1024,
  retainedBytes: 128 * 1024 * 1024,
  records: 32,
} as const;
const capturedText = z
  .string()
  .max(HUDDLE_LIMITS.fileBytes)
  .refine((value) => new TextEncoder().encode(value).length <= HUDDLE_LIMITS.fileBytes);
export const huddleRevisionDocumentSchema = z.strictObject({
  format: z.literal(1),
  digest: huddleRevisionSchema,
  files: z
    .record(huddleRelativePathSchema, capturedText)
    .refine(
      (files) =>
        Object.keys(files).length <= HUDDLE_LIMITS.files &&
        Object.values(files).reduce(
          (total, value) => total + new TextEncoder().encode(value).length,
          0,
        ) <= HUDDLE_LIMITS.bundleBytes,
    ),
  components: z
    .record(huddleKeySchema, huddleComponentSchema)
    .refine((value) => Object.keys(value).length <= HUDDLE_LIMITS.nodes),
});
export type HuddleRevisionDocument = z.infer<typeof huddleRevisionDocumentSchema>;

const resourceBindings = z
  .record(huddleKeySchema, z.string().min(1).max(4096))
  .refine((value) => Object.keys(value).length <= HUDDLE_LIMITS.ports);
export const huddleRevisionActivationSchema = z.strictObject({
  id: z.uuid(),
  revision: huddleRevisionSchema,
  worktree: z.string().min(1).max(4096),
  variables: huddleNamedValuesSchema,
  bindings: z
    .record(huddleKeySchema, resourceBindings)
    .refine(
      (value) =>
        Object.keys(value).length <= HUDDLE_LIMITS.nodes &&
        huddleJsonSchema.safeParse(value).success,
    ),
  appliedAt: z.number().int().nonnegative().safe(),
});
export type HuddleRevisionActivation = z.infer<typeof huddleRevisionActivationSchema>;

export const huddleControlStateSchema = z.strictObject({
  generation: z.number().int().nonnegative().safe(),
  activationId: z.uuid().nullable(),
  state: z.enum(['stopped', 'armed', 'interrupted']),
  autoStart: z.boolean(),
});
export type HuddleControlState = z.infer<typeof huddleControlStateSchema>;
