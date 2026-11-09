import { z } from 'zod';
import { huddleOpenSchema } from './authoring.js';
import { huddleDiagnosticSchema } from './definitions.js';
import { huddleJsonSchema, huddleKeySchema, huddleRelativePathSchema } from './values.js';

/** Explicit saved-source checking; fixture paths are relative to the selected huddle. */
export const huddleValidateSchema = huddleOpenSchema.extend({
  fixtures: z.array(huddleRelativePathSchema).max(16).optional(),
});
export type HuddleValidate = z.infer<typeof huddleValidateSchema>;

const values = z
  .record(huddleKeySchema, huddleJsonSchema)
  .refine((value) => Object.keys(value).length <= 64 && huddleJsonSchema.safeParse(value).success);
export const huddleContractFixtureSchema = z.strictObject({
  format: z.literal(1),
  cases: z
    .array(
      z
        .strictObject({
          name: z.string().min(1).max(200),
          node: huddleKeySchema,
          inputs: values.optional(),
          parameters: values.optional(),
          outputs: values.optional(),
          emissions: z
            .array(z.strictObject({ port: huddleKeySchema, value: huddleJsonSchema }))
            .max(64)
            .optional(),
        })
        .refine(
          (value) =>
            value.inputs !== undefined ||
            value.parameters !== undefined ||
            value.outputs !== undefined ||
            value.emissions !== undefined,
          'Supply at least one sample to check',
        ),
    )
    .min(1)
    .max(64),
});

export const huddleValidationSchema = z.strictObject({
  valid: z.boolean(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  // The new checker emits at most 512; older graph-only hosts can report more.
  diagnostics: z.array(huddleDiagnosticSchema),
  checks: z
    .strictObject({
      modules: z.literal(true),
      fixtures: z
        .array(
          z.strictObject({
            path: huddleRelativePathSchema,
            digest: z.string().regex(/^[a-f0-9]{64}$/),
            cases: z.number().int().min(0).max(64),
          }),
        )
        .max(16),
    })
    .optional(),
});
export type HuddleValidation = z.infer<typeof huddleValidationSchema>;
