import { z } from 'zod';
import { huddleJsonSchema, huddleKeySchema, huddleNamedValuesSchema } from '@puddle/shared';

const response = z.union([
  z.strictObject({ reply: huddleJsonSchema }),
  z.strictObject({ error: z.string().min(1).max(4096) }),
]);
const strings = z
  .record(huddleKeySchema, z.string().max(4096))
  .refine((value) => Object.keys(value).length <= 64);
export const huddleExecutableCaseSchema = z.strictObject({
  name: z.string().min(1).max(200),
  node: huddleKeySchema,
  inputs: huddleNamedValuesSchema.default({}),
  parameters: huddleNamedValuesSchema.default({}),
  bindings: strings.default({}),
  secrets: strings.default({}),
  cursor: huddleJsonSchema.default(null),
  mode: z.enum(['deliver', 'observe']).default('deliver'),
  observeMs: z.number().int().min(0).max(5000).default(0),
  abortAfterMs: z.number().int().min(1).max(5000).optional(),
  fetch: z
    .array(
      z.strictObject({
        url: z.string().min(1).max(8192),
        method: z.string().min(1).max(32).default('GET'),
        body: z.string().max(262144).optional(),
        status: z.number().int().min(200).max(599).default(200),
        response,
      }),
    )
    .max(64)
    .default([]),
  operations: z
    .array(z.strictObject({ request: huddleJsonSchema, response }))
    .max(64)
    .default([]),
  expect: z
    .strictObject({
      outputs: huddleNamedValuesSchema.optional(),
      result: huddleJsonSchema.optional(),
      emissions: z.array(huddleJsonSchema).max(64).optional(),
      health: z.array(huddleJsonSchema).max(64).optional(),
      checkpoints: z.array(huddleJsonSchema).max(64).optional(),
      errorIncludes: z.string().min(1).max(4096).optional(),
    })
    .refine((value) => Object.keys(value).length > 0, 'Declare an expected result'),
});
export const huddleExecutableFixtureSchema = z.strictObject({
  format: z.literal(1),
  cases: z.array(huddleExecutableCaseSchema).min(1).max(64),
});
export type HuddleExecutableCase = z.infer<typeof huddleExecutableCaseSchema>;
