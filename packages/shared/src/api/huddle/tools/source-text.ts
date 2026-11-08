import { z } from 'zod';
import { huddleToolDefinitionSchema } from './source.js';
import { huddleSaveSourceSchema } from '../source.js';

export const huddleToolSaveSourceSchema = huddleSaveSourceSchema.extend({
  worktree: huddleToolDefinitionSchema.shape.worktree,
});
export const huddleSourceMcpTools = [
  {
    name: 'huddle_source',
    description:
      'Read exact captured huddle source files and the same capture’s document/digest. Includes referenced scripts without evaluating them. Explicit project/worktree scope; requires host 28.11.',
    inputSchema: z.toJSONSchema(huddleToolDefinitionSchema, { io: 'input' }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'huddle_save_source',
    description:
      'Save exact huddle.json or layout.json text against an explicitly reviewed whole-capture expected_digest. Never activates code. Returns observed source; lost replies require source inspection, never automatic retry or a substituted digest. Requires host 28.11.',
    inputSchema: z.toJSONSchema(huddleToolSaveSourceSchema, { io: 'input' }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] as const;
