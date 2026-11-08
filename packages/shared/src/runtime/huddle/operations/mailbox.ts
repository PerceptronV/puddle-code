import { z } from 'zod';
import { runtimeTurnResultSchema } from '../../protocol.js';
import { puddlangAskSchema } from '../../../api/agents/puddlang.js';
import { huddleJsonSchema, huddleKeySchema } from '../../../api/huddle/values.js';
import { huddleRevisionSchema } from '../../../api/huddle/events.js';
import { huddleTurnScopeSchema } from './agents.js';

export const HUDDLE_OPERATION_PAGE_LIMITS = { records: 16, bytes: 1024 * 1024 } as const;
export const huddleAgentOutcomeSchema = z
  .strictObject({
    turn: runtimeTurnResultSchema.refine((value) => value.status !== 'running'),
    receipt: huddleRevisionSchema,
  })
  .refine(
    (value) => huddleJsonSchema.safeParse(value).success,
    'Agent outcome exceeds huddle value limits',
  );
export type HuddleAgentOutcome = z.infer<typeof huddleAgentOutcomeSchema>;
export const huddleAgentOperationSchema = z
  .strictObject({
    scope: huddleTurnScopeSchema,
    node: huddleKeySchema,
    request: puddlangAskSchema.refine((value) => huddleJsonSchema.safeParse(value).success),
    deadline: z.number().int().nonnegative().safe(),
    active: z.boolean(),
    state: z.enum(['prepared', 'dispatched', 'completed', 'failed', 'unknown', 'cancelled']),
    result: huddleAgentOutcomeSchema.optional(),
  })
  .refine((value) => {
    if (value.state === 'completed') return value.result?.turn.status === 'completed';
    if (value.state === 'failed') return !!value.result && value.result.turn.status !== 'completed';
    return value.result === undefined;
  }, 'Operation state differs from its retained outcome');
export type HuddleAgentOperation = z.infer<typeof huddleAgentOperationSchema>;
export const huddleOperationPageSchema = z
  .strictObject({
    records: z
      .array(
        z.strictObject({
          ordinal: z.number().int().positive().safe(),
          operation: huddleAgentOperationSchema,
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
  }, 'Operation page must have ordered unique records within its cursor')
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <= HUDDLE_OPERATION_PAGE_LIMITS.bytes,
  );
