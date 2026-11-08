import { z } from 'zod';
import { agentModeSchema } from '../../../api/agents/sessions.js';
import { huddleTurnScopeSchema } from './agents.js';

/** Resolved host resources, not worker-selected defaults or a public create request. */
export const huddleSpawnRequestSchema = z.strictObject({
  projectId: huddleTurnScopeSchema.shape.owner.shape.project_id,
  worktree: z.string().min(1).max(4096),
  accountId: z.number().int().positive().safe(),
  agent: z.string().min(1).max(100),
  mode: agentModeSchema,
  title: z.string().min(1).max(200),
});
export type HuddleSpawnRequest = z.infer<typeof huddleSpawnRequestSchema>;
export const huddleSpawnScopeSchema = huddleTurnScopeSchema.omit({ target: true });
export type HuddleSpawnScope = z.infer<typeof huddleSpawnScopeSchema>;
