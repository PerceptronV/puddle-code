import { z } from 'zod';
import { huddleAppearanceSchema, huddleComponentIdSchema } from './components.js';
import { huddleParametersSchema } from './contracts.js';
import {
  HUDDLE_LIMITS,
  huddleIdSchema,
  huddleJsonSchema,
  huddleKeySchema,
  huddleRelativePathSchema,
} from './values.js';

export const huddleBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('literal'), value: huddleJsonSchema }),
  z.strictObject({ kind: z.literal('variable'), name: huddleKeySchema }),
]);
export type HuddleBinding = z.infer<typeof huddleBindingSchema>;

export const huddleNodeSchema = z.strictObject({
  id: huddleKeySchema,
  source: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('builtin'),
      component: huddleComponentIdSchema,
      version: z.number().int().positive(),
    }),
    z.strictObject({ kind: z.literal('local'), manifest: huddleRelativePathSchema }),
  ]),
  parameters: z
    .record(huddleKeySchema, huddleBindingSchema)
    .refine((value) => Object.keys(value).length <= HUDDLE_LIMITS.ports)
    .default({}),
  appearance: huddleAppearanceSchema.optional(),
  concurrency: z.number().int().min(1).max(32).default(1),
});
export type HuddleNodeDefinition = z.infer<typeof huddleNodeSchema>;

export const huddleEndpointSchema = z.strictObject({
  node: huddleKeySchema,
  port: huddleKeySchema,
});
export const huddleEdgeSchema = z.strictObject({
  id: huddleKeySchema,
  from: huddleEndpointSchema,
  to: huddleEndpointSchema,
  feedback: z
    .strictObject({
      maxRounds: z.number().int().min(1).max(1000),
      while: z.strictObject({ path: z.array(huddleKeySchema).min(1).max(16), equals: z.boolean() }),
    })
    .optional(),
});
export type HuddleEdge = z.infer<typeof huddleEdgeSchema>;

export const huddleTriggerAdmissionSchema = z.strictObject({
  policy: z.enum(['queue', 'coalesce', 'drop']),
  maxQueuedEvents: z.number().int().min(1).max(4096),
});

export const huddleDefinitionSchema = z.strictObject({
  format: z.literal(1),
  id: huddleIdSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(4096).default(''),
  variables: huddleParametersSchema.default({}),
  nodes: z.array(huddleNodeSchema).max(HUDDLE_LIMITS.nodes),
  edges: z.array(huddleEdgeSchema).max(HUDDLE_LIMITS.edges),
  execution: z
    .strictObject({
      concurrency: z.number().int().min(1).max(16).default(1),
      maxTurns: z.number().int().min(1).max(1000).default(50),
      maxAgents: z.number().int().min(1).max(32).default(8),
      timeoutMs: z.number().int().min(1000).max(86_400_000).default(3_600_000),
      maxQueuedEvents: z.number().int().min(1).max(4096).default(128),
      maxDailyExecutions: z.number().int().min(1).max(10_000).default(100),
      maxDailyAgentSpawns: z.number().int().min(1).max(1000).default(32),
      maxInvocations: z.number().int().min(1).max(4096).default(512),
      queue: z.enum(['queue', 'coalesce', 'drop']).default('queue'),
      triggerAdmission: z
        .record(huddleKeySchema, huddleTriggerAdmissionSchema)
        .refine((value) => Object.keys(value).length <= HUDDLE_LIMITS.nodes)
        .optional(),
      cleanup: z.enum(['stop-owned', 'retain-owned']).default('stop-owned'),
    })
    .prefault({}),
});
export type HuddleDefinition = z.infer<typeof huddleDefinitionSchema>;

export const huddleLayoutSchema = z.strictObject({
  format: z.literal(1),
  labels: z
    .record(huddleKeySchema, z.string().trim().min(1).max(200))
    .refine((value) => Object.keys(value).length <= HUDDLE_LIMITS.nodes)
    .optional(),
  nodes: z
    .record(
      huddleKeySchema,
      z.strictObject({
        x: z.number().finite().min(-1_000_000).max(1_000_000),
        y: z.number().finite().min(-1_000_000).max(1_000_000),
      }),
    )
    .refine((value) => Object.keys(value).length <= HUDDLE_LIMITS.nodes),
});
export type HuddleLayout = z.infer<typeof huddleLayoutSchema>;

export const huddleDiagnosticSchema = z.strictObject({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  path: z.string(),
  message: z.string(),
  node: z.string().optional(),
  edge: z.string().optional(),
});
export type HuddleDiagnostic = z.infer<typeof huddleDiagnosticSchema>;
