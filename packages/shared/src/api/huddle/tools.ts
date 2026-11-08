import { z } from 'zod';
import { huddleLocationSchema } from './authoring.js';
import { huddleDiagnosticSchema } from './definitions.js';
import { huddleIdSchema } from './values.js';

/** CLI/MCP locations are on the selected host, never resolved against the client cwd. */
export const huddleToolLocationSchema = huddleLocationSchema.extend({
  worktree: z.string().min(1).max(4096).regex(/^\//, 'Choose an absolute host worktree'),
});
export const huddleToolDefinitionSchema = huddleToolLocationSchema.extend({
  huddle_id: huddleIdSchema,
});
export const huddleValidationSchema = z.strictObject({
  valid: z.boolean(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  diagnostics: z.array(huddleDiagnosticSchema),
});
export type HuddleValidation = z.infer<typeof huddleValidationSchema>;

const definitions = [
  [
    'huddle_list',
    'List saved huddles and source diagnostics in an explicit project/worktree on the selected host/profile. Does not open sessions or activate graphs.',
    huddleToolLocationSchema,
  ],
  [
    'huddle_inspect',
    'Inspect a saved huddle definition, component contracts, layout, source digest and diagnostics without evaluating scripts or creating a runtime.',
    huddleToolDefinitionSchema,
  ],
  [
    'huddle_validate',
    'Validate saved huddle source and graph contracts. Returns valid, digest and node/edge/path diagnostics. Does not type-check or execute scripts, check live provider/resource admission, arm triggers or activate code.',
    huddleToolDefinitionSchema,
  ],
] as const;
export const huddleMcpTools = definitions.map(([name, description, schema]) => ({
  name,
  description,
  inputSchema: z.toJSONSchema(schema, { io: 'input' }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}));
