import { z } from 'zod';
import { runtimeIdentitySchema } from '../../protocol.js';
import { huddleRevisionSchema } from '../../../api/huddle/events.js';
import { canonicalHuddleJson } from '../../../api/huddle/values.js';

export const huddleAgentTargetSchema = z.strictObject({
  runtimeId: z.uuid(),
  incarnation: z.uuid(),
  sessionId: z.uuid(),
  projectId: runtimeIdentitySchema.shape.project_id,
  worktree: runtimeIdentitySchema.shape.canonical_worktree_path,
});
export type HuddleAgentTarget = z.infer<typeof huddleAgentTargetSchema>;
export const huddleTurnScopeSchema = z.strictObject({
  owner: runtimeIdentitySchema,
  executionId: z.uuid(),
  invocationId: z.uuid(),
  operationId: z.uuid(),
  activationId: z.uuid(),
  revision: huddleRevisionSchema,
  target: huddleAgentTargetSchema,
});
export type HuddleTurnScope = z.infer<typeof huddleTurnScopeSchema>;

const prefix = 'huddle-agent:';
/** Resolved, inspectable reference stored in an activation. It grants no authority by itself. */
export function encodeHuddleAgentTarget(target: HuddleAgentTarget): string {
  return z
    .string()
    .max(4096)
    .parse(prefix + canonicalHuddleJson(huddleAgentTargetSchema.parse(target)));
}
export function decodeHuddleAgentTarget(value: string): HuddleAgentTarget {
  if (!value.startsWith(prefix) || value.length > 4096)
    throw new Error('Invalid huddle agent binding');
  return huddleAgentTargetSchema.parse(JSON.parse(value.slice(prefix.length)));
}
