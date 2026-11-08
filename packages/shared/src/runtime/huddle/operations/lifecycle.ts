import { z } from 'zod';
import { canonicalHuddleJson, huddleKeySchema } from '../../../api/huddle/values.js';
import { agentModeSchema } from '../../../api/agents/sessions.js';
import { huddleAgentTargetSchema } from './agents.js';
import { huddleSpawnScopeSchema, huddleSpawnOutcomeSchema } from './spawns.js';
import { HUDDLE_OPERATION_PAGE_LIMITS } from './mailbox.js';

export const huddleLifecycleTargetSchema = z
  .strictObject({
    sessionId: z.uuid(),
    projectId: huddleAgentTargetSchema.shape.projectId,
    worktree: huddleAgentTargetSchema.shape.worktree,
    accountId: z.number().int().positive(),
    agent: z.string().min(1).max(100),
    mode: agentModeSchema,
    nativeRef: z.string().min(1).max(2048),
    runtime: huddleAgentTargetSchema.nullable(),
  })
  .refine(
    (target) =>
      !target.runtime ||
      (target.runtime.sessionId === target.sessionId &&
        target.runtime.projectId === target.projectId &&
        target.runtime.worktree === target.worktree),
    'Lifecycle runtime differs from its placement',
  );
export type HuddleLifecycleTarget = z.infer<typeof huddleLifecycleTargetSchema>;
export const huddleLifecycleRequestSchema = z
  .strictObject({
    action: z.enum(['resume', 'restart']),
    target: huddleLifecycleTargetSchema,
  })
  .refine(
    (request) =>
      request.action === 'restart'
        ? request.target.runtime !== null
        : request.target.runtime === null,
    'Resume requires a stopped placement; restart requires a captured runtime',
  );
export type HuddleLifecycleRequest = z.infer<typeof huddleLifecycleRequestSchema>;
export const huddleLifecycleOperationSchema = z
  .strictObject({
    scope: huddleSpawnScopeSchema,
    node: huddleKeySchema,
    request: huddleLifecycleRequestSchema,
    deadline: z.number().int().nonnegative().safe(),
    active: z.boolean(),
    state: z.enum(['prepared', 'dispatched', 'completed', 'failed', 'unknown', 'cancelled']),
    result: z
      .union([huddleSpawnOutcomeSchema, z.strictObject({ rejected: z.string().min(1).max(4096) })])
      .optional(),
  })
  .refine(
    (value) =>
      value.state === 'completed'
        ? !!value.result && 'agent' in value.result
        : value.state === 'failed'
          ? !!value.result && 'rejected' in value.result
          : value.result === undefined,
    'Lifecycle state differs from its retained result',
  );
export type HuddleLifecycleOperation = z.infer<typeof huddleLifecycleOperationSchema>;
export const huddleLifecyclePageSchema = z
  .strictObject({
    records: z
      .array(
        z.strictObject({
          ordinal: z.number().int().positive().safe(),
          operation: huddleLifecycleOperationSchema,
        }),
      )
      .max(HUDDLE_OPERATION_PAGE_LIMITS.records),
    next: z.number().int().nonnegative().safe(),
  })
  .refine((page) => {
    let previous = 0;
    const ids = new Set<string>();
    for (const row of page.records) {
      if (
        row.ordinal <= previous ||
        row.ordinal > page.next ||
        ids.has(row.operation.scope.operationId)
      )
        return false;
      previous = row.ordinal;
      ids.add(row.operation.scope.operationId);
    }
    return (
      new TextEncoder().encode(JSON.stringify(page)).length <= HUDDLE_OPERATION_PAGE_LIMITS.bytes
    );
  });
const prefix = 'huddle-session:';
export function encodeHuddleLifecycleTarget(target: HuddleLifecycleTarget): string {
  return z
    .string()
    .max(4096)
    .parse(prefix + canonicalHuddleJson(huddleLifecycleTargetSchema.parse(target)));
}
export function decodeHuddleLifecycleTarget(value: string): HuddleLifecycleTarget {
  if (!value.startsWith(prefix) || value.length > 4096)
    throw new Error('Invalid lifecycle binding');
  return huddleLifecycleTargetSchema.parse(JSON.parse(value.slice(prefix.length)));
}
