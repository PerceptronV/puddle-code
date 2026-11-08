import { z } from 'zod';
import { runtimeIdentitySchema, huddleRevisionSchema } from '@puddle/shared';

/** Supplied by the private owner bridge after validating its retained invocation and bindings. */
export const huddleTurnScopeSchema = z.strictObject({
  owner: runtimeIdentitySchema,
  executionId: z.uuid(),
  invocationId: z.uuid(),
  operationId: z.uuid(),
  activationId: z.uuid(),
  revision: huddleRevisionSchema,
  target: z.strictObject({
    runtimeId: z.uuid(),
    incarnation: z.uuid(),
    sessionId: z.uuid(),
    projectId: runtimeIdentitySchema.shape.project_id,
    worktree: runtimeIdentitySchema.shape.canonical_worktree_path,
  }),
});
export type HuddleTurnScope = z.infer<typeof huddleTurnScopeSchema>;
/** Observation includes receipt delivery and exact admitted-turn cancellation, never a fresh prompt. */
export type HuddleTurnAuthority = (mode: 'dispatch' | 'observe') => boolean;
