import { z } from 'zod';
import {
  HUDDLE_LIMITS,
  huddleJsonSchema,
  huddleKeySchema,
  isHuddleJson,
  type HuddleJson,
} from './values.js';

const valueTypes = ['null', 'boolean', 'number', 'integer', 'string', 'array', 'object'] as const;
export type HuddleValueType = (typeof valueTypes)[number];
export interface HuddleValueSchema {
  type?: HuddleValueType | HuddleValueType[];
  title?: string;
  description?: string;
  enum?: HuddleJson[];
  properties?: Record<string, HuddleValueSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: HuddleValueSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

const schemaShape: z.ZodType<HuddleValueSchema> = z.lazy(() =>
  z
    .strictObject({
      type: z.union([z.enum(valueTypes), z.array(z.enum(valueTypes)).min(1).max(7)]).optional(),
      title: z.string().max(200).optional(),
      description: z.string().max(4096).optional(),
      enum: z.array(huddleJsonSchema).min(1).max(128).optional(),
      properties: z
        .record(huddleKeySchema, schemaShape)
        .refine((v) => Object.keys(v).length <= HUDDLE_LIMITS.ports)
        .optional(),
      required: z.array(huddleKeySchema).max(HUDDLE_LIMITS.ports).optional(),
      additionalProperties: z.boolean().optional(),
      items: schemaShape.optional(),
      minItems: z.number().int().min(0).max(HUDDLE_LIMITS.valueEntries).optional(),
      maxItems: z.number().int().min(0).max(HUDDLE_LIMITS.valueEntries).optional(),
      minLength: z.number().int().min(0).max(HUDDLE_LIMITS.valueBytes).optional(),
      maxLength: z.number().int().min(0).max(HUDDLE_LIMITS.valueBytes).optional(),
      minimum: z.number().finite().optional(),
      maximum: z.number().finite().optional(),
    })
    .superRefine((value, ctx) => {
      const types =
        value.type === undefined ? [] : Array.isArray(value.type) ? value.type : [value.type];
      if (new Set(types).size !== types.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate value type' });
      if (new Set(value.required).size !== (value.required?.length ?? 0))
        ctx.addIssue({ code: 'custom', message: 'Duplicate required property' });
      for (const key of value.required ?? []) {
        if (!Object.hasOwn(value.properties ?? {}, key))
          ctx.addIssue({
            code: 'custom',
            path: ['required'],
            message: `Required property ${key} is not declared`,
          });
      }
      for (const [min, max] of [
        [value.minItems, value.maxItems],
        [value.minLength, value.maxLength],
        [value.minimum, value.maximum],
      ]) {
        if (min !== undefined && max !== undefined && min > max)
          ctx.addIssue({ code: 'custom', message: 'Minimum exceeds maximum' });
      }
    }),
);

/** Unsupported JSON Schema keywords fail explicitly rather than weakening validation. */
export const huddleValueSchema = z
  .unknown()
  .refine((value): boolean => isHuddleJson(value), 'Expected a bounded schema')
  .pipe(schemaShape);

export const huddleParameterSchema = z.strictObject({
  schema: huddleValueSchema,
  title: z.string().max(200).optional(),
  description: z.string().max(4096).optional(),
  required: z.boolean().default(true),
  default: huddleJsonSchema.optional(),
  editor: z
    .enum([
      'json',
      'text',
      'prompt',
      'number',
      'boolean',
      'account',
      'agent',
      'mode',
      'project',
      'worktree',
      'session',
      'duration',
      'enum',
    ])
    .default('json'),
});
export type HuddleParameter = z.infer<typeof huddleParameterSchema>;

export const huddlePortSchema = z.strictObject({
  schema: huddleValueSchema,
  title: z.string().max(200).optional(),
  required: z.boolean().default(true),
  emission: z.enum(['completion', 'event']).default('completion'),
});
export type HuddlePort = z.infer<typeof huddlePortSchema>;

export const huddleParametersSchema = z
  .record(huddleKeySchema, huddleParameterSchema)
  .refine((value) => Object.keys(value).length <= HUDDLE_LIMITS.ports, 'Too many parameters');
export const huddlePortsSchema = z
  .record(huddleKeySchema, huddlePortSchema)
  .refine((value) => Object.keys(value).length <= HUDDLE_LIMITS.ports, 'Too many ports');
