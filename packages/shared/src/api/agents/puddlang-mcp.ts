import { z } from 'zod';
import { puddlangStartSchema } from './puddlang.js';
import {
  puddlangOutcomeOperationSchema,
  puddlangOutcomeRequestSchema,
} from './puddlang-outcomes.js';

export const puddlangMcpRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export const puddlangMcpCallSchema = z.object({
  name: z.string(),
  arguments: z.unknown().optional(),
});
export const puddlangMcpRunSchema = puddlangStartSchema;
export const puddlangMcpIdSchema = z.object({ id: z.uuid() });
export const puddlangMcpEventsSchema = puddlangMcpIdSchema.extend({
  after: z.number().int().nonnegative().default(0),
});
export const puddlangMcpEmptySchema = z.object({}).strict();
export const puddlangMcpOutcomesSchema = puddlangMcpIdSchema
  .extend({
    after: puddlangOutcomeOperationSchema.optional(),
  })
  .strict();
export const puddlangMcpOutcomeSchema = puddlangOutcomeRequestSchema
  .extend({
    id: z.uuid(),
    operation: puddlangOutcomeOperationSchema,
  })
  .strict();
const definitions = [
  [
    'puddlang_context',
    'List this host profile, projects, accounts and supported agents.',
    puddlangMcpEmptySchema,
    true,
  ],
  [
    'puddlang_run',
    'Execute a trusted single-file TypeScript programme on the host. Imports: puddlang (spawn, attach, input, z), zod, node: built-ins. Returns immediately with a durable run id; use status/events. Supply a fresh UUID id, or reuse it with identical input to recover an uncertain submission. spawn({agent:"codex",project:"name",account:"label"}); await agent.ask("task"); export default result. Supports structured ask({prompt,input,schema:z.object(...)}) and agent.stop().',
    puddlangMcpRunSchema,
    false,
  ],
  [
    'puddlang_status',
    'Read a run and its final default export, if finished.',
    puddlangMcpIdSchema,
    true,
  ],
  [
    'puddlang_events',
    'Read up to 100 events after a sequence; paginate until empty.',
    puddlangMcpEventsSchema,
    true,
  ],
  [
    'puddlang_cancel',
    'Cancel a run, interrupt its pending asks, and stop agents it created. Attached agents are retained.',
    puddlangMcpIdSchema,
    false,
  ],
  [
    'puddlang_outcomes',
    'Inspect up to 50 retained outcome identities for a run without reading reply text or releasing retention. Use next_after to paginate. Requires application 26.1+.',
    puddlangMcpOutcomesSchema,
    true,
  ],
  [
    'puddlang_outcome',
    'Explicitly read or discard one unchanged terminal outcome of a finished programme, using its inspected fingerprint. Both actions release retention for later reclamation and create a metadata-only audit. No programme or prompt is replayed. Repeating the same disposition observes it; a reclaimed reply is unavailable. Requires application 26.1+.',
    puddlangMcpOutcomeSchema,
    false,
  ],
] as const;
export const puddlangMcpTools = definitions.map(([name, description, schema, readOnlyHint]) => ({
  name,
  description,
  inputSchema: z.toJSONSchema(schema, { io: 'input' }),
  annotations: {
    readOnlyHint,
    destructiveHint: !readOnlyHint,
    idempotentHint: true,
    openWorldHint: !readOnlyHint,
  },
}));
