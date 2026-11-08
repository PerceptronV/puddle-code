import { z } from 'zod';
import { huddleKeySchema } from '../../../api/huddle/values.js';
import { HUDDLE_OPERATION_PAGE_LIMITS } from './mailbox.js';
import {
  huddleSpawnOutcomeSchema,
  huddleSpawnRequestSchema,
  huddleSpawnScopeSchema,
} from './spawns.js';

export const huddleSpawnRejectionSchema = z.strictObject({ rejected: z.string().min(1).max(4096) });

/** Internal owner queue contract. Transport support is negotiated separately. */
export const huddleSpawnOperationSchema = z
  .strictObject({
    scope: huddleSpawnScopeSchema,
    node: huddleKeySchema,
    request: huddleSpawnRequestSchema,
    deadline: z.number().int().nonnegative().safe(),
    active: z.boolean(),
    state: z.enum(['prepared', 'dispatched', 'completed', 'failed', 'unknown', 'cancelled']),
    result: z.union([huddleSpawnOutcomeSchema, huddleSpawnRejectionSchema]).optional(),
  })
  .refine((value) => {
    if (value.request.projectId !== value.scope.owner.project_id) return false;
    if (value.state === 'completed')
      return (
        !!value.result &&
        'agent' in value.result &&
        value.result.agent.projectId === value.request.projectId &&
        value.result.agent.worktree === value.request.worktree
      );
    if (value.state === 'failed') return !!value.result && 'rejected' in value.result;
    return value.result === undefined;
  }, 'Spawn state or scope differs from its retained outcome');
export type HuddleSpawnOperation = z.infer<typeof huddleSpawnOperationSchema>;

export const huddleSpawnPageSchema = z
  .strictObject({
    records: z
      .array(
        z.strictObject({
          ordinal: z.number().int().positive().safe(),
          operation: huddleSpawnOperationSchema,
        }),
      )
      .max(HUDDLE_OPERATION_PAGE_LIMITS.records),
    next: z.number().int().nonnegative().safe(),
  })
  .refine((value) => {
    let previous = 0;
    const ids = new Set<string>();
    for (const { ordinal, operation } of value.records) {
      if (ordinal <= previous || ordinal > value.next || ids.has(operation.scope.operationId))
        return false;
      previous = ordinal;
      ids.add(operation.scope.operationId);
    }
    return true;
  }, 'Spawn page must have ordered unique records within its cursor')
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <= HUDDLE_OPERATION_PAGE_LIMITS.bytes,
  );
