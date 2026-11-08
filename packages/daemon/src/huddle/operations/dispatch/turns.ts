import { setTimeout as delay } from 'node:timers/promises';
import {
  canonicalHuddleJson,
  huddleJsonSchema,
  huddleAgentOutcomeSchema,
  type HuddleAgentOperation,
  type HuddleAgentOutcome,
} from '@puddle/shared';
import type { HuddleAgentTurns } from '../turns/service.js';
import type { HuddleDispatchContext } from './context.js';

/** Exact turn dispatch and receipt acknowledgement; queue ownership stays with the shared dispatcher. */
export async function executeHuddleAsk(
  {
    task,
    client,
    current,
    authority,
    canCancel,
    changed,
  }: HuddleDispatchContext<HuddleAgentOperation>,
  turns: HuddleAgentTurns,
) {
  const { scope, request } = task.operation;
  let invoked = false;
  let outcomeObserved = false;
  let settlementAttempted = false;
  const settle = async (result: HuddleAgentOutcome) => {
    if (!huddleAgentOutcomeSchema.safeParse(result).success)
      throw new Error('Agent reply exceeds huddle outcome limits');
    settlementAttempted = true;
    const saved = await client.request({ t: 'operation-settle', scope, result });
    if (!current()) return;
    if (
      saved.t !== 'operation-settled' ||
      saved.operationId !== scope.operationId ||
      canonicalHuddleJson(saved.result) !== canonicalHuddleJson(result)
    )
      throw new Error('Owner did not confirm its exact retained outcome');
    turns.acknowledge(scope, request, result.receipt, authority);
  };
  try {
    if (task.operation.result && 'turn' in task.operation.result) {
      turns.acknowledge(scope, request, task.operation.result.receipt, authority);
      return;
    }
    if (task.operation.state === 'prepared') {
      if (!authority('dispatch')) return;
      const claimed = await client.request({
        t: 'operation-claim',
        operationId: scope.operationId,
      });
      if (!current() || claimed.t !== 'operation-claim') return;
      if (
        canonicalHuddleJson(claimed.operation.scope) !== canonicalHuddleJson(scope) ||
        canonicalHuddleJson(huddleJsonSchema.parse(claimed.operation.request)) !==
          canonicalHuddleJson(huddleJsonSchema.parse(request))
      )
        throw new Error('Claim changed the retained operation');
      task.operation = claimed.operation;
      if (claimed.dispatch) {
        invoked = true;
        await turns.ask(scope, request, task.abort.signal, authority, () => true);
      }
    }
    for (;;) {
      if (!current()) return;
      const observed = turns.observe(scope, request, authority);
      if (observed.result && observed.receipt) {
        outcomeObserved = true;
        await settle({ turn: observed.result, receipt: observed.receipt });
        return;
      }
      task.abort.signal.throwIfAborted();
      if (!task.operation.active) {
        task.abort.abort(new Error('Huddle invocation ended'));
        task.abort.signal.throwIfAborted();
      }
      await delay(250, undefined, { signal: task.abort.signal });
    }
  } catch (error) {
    if (task.abort.signal.aborted && canCancel()) {
      try {
        await turns.cancel(scope, request, authority);
      } catch {
        /* Exact intent prevents a second cancellation send. */
      }
    }
    if (!current()) return;
    if (settlementAttempted) {
      changed(); // Re-read the owner ledger before another settlement attempt.
      return;
    }
    if (!invoked && !outcomeObserved) return;
    // A terminal agent failure still has a result requiring durable settlement.
    try {
      const observed = turns.observe(scope, request, authority);
      if (observed.result && observed.receipt) {
        await settle({ turn: observed.result, receipt: observed.receipt });
        return;
      }
    } catch {
      /* Keep retained host results unacknowledged when settlement is unavailable. */
    }
    if (settlementAttempted) {
      changed();
      return;
    }
    try {
      await client.request({
        t: 'operation-unavailable',
        scope,
        unsent: turns.unused(scope, request, authority),
        error:
          (error instanceof Error ? error.message : String(error)).slice(0, 4096) ||
          'Agent operation failed',
      });
    } catch {
      /* Lost replies remain observation-only. */
    }
  }
}
