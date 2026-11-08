import { setTimeout as delay } from 'node:timers/promises';
import {
  canonicalHuddleJson,
  huddleSpawnOutcomeSchema,
  type HuddleLifecycleOperation,
  type HuddleSpawnOutcome,
} from '@puddle/shared';
import type { HuddleAgentLifecycle } from '../lifecycle/service.js';
import type { HuddleDispatchContext } from './context.js';

/** A fresh claim permits one lifecycle action; all subsequent visits only observe retained host state. */
export async function executeHuddleLifecycle(
  { task, client, current, authority, changed }: HuddleDispatchContext<HuddleLifecycleOperation>,
  lifecycle: HuddleAgentLifecycle,
) {
  const { scope, request } = task.operation;
  let invoked = false;
  let claiming = false;
  let settling = false;
  const settle = async (raw: HuddleSpawnOutcome) => {
    const result = huddleSpawnOutcomeSchema.parse(raw);
    settling = true;
    const saved = await client.request({ t: 'lifecycle-settle', scope, result });
    if (!current()) return;
    if (
      saved.t !== 'lifecycle-settled' ||
      saved.operationId !== scope.operationId ||
      canonicalHuddleJson(saved.result) !== canonicalHuddleJson(result)
    )
      throw new Error('Owner did not confirm its retained lifecycle action outcome');
  };
  try {
    if (task.operation.state === 'completed' || task.operation.state === 'failed') return;
    if (task.operation.state === 'prepared') {
      if (!authority('dispatch')) return;
      claiming = true;
      const claimed = await client.request({
        t: 'lifecycle-claim',
        operationId: scope.operationId,
      });
      if (!current() || claimed.t !== 'lifecycle-claim') return;
      if (
        canonicalHuddleJson(claimed.operation.scope) !== canonicalHuddleJson(scope) ||
        canonicalHuddleJson(claimed.operation.request) !== canonicalHuddleJson(request)
      )
        throw new Error('Claim changed the retained lifecycle action');
      task.operation = claimed.operation;
      if (claimed.dispatch) {
        invoked = true;
        await lifecycle.execute(scope, request, authority);
      }
    }
    for (;;) {
      if (!current()) return;
      const result = lifecycle.observe(scope, request, authority);
      if (result) {
        await settle(result);
        return;
      }
      // Ended invocations remain observable on later host/owner changes. They never create work.
      if (!task.operation.active) return;
      task.abort.signal.throwIfAborted();
      await delay(250, undefined, { signal: task.abort.signal });
    }
  } catch (error) {
    // Dispatcher shutdown, maintenance or a disconnected controller does not authorise agent cleanup.
    if (!current()) return;
    if (settling) {
      changed();
      return;
    }
    if (!invoked) {
      if (claiming) changed();
      return;
    }
    try {
      const result = lifecycle.observe(scope, request, authority);
      if (result) {
        await settle(result);
        return;
      }
    } catch {
      /* Retained readiness remains available to a later authorised observer. */
    }
    if (settling) {
      changed();
      return;
    }
    try {
      await client.request({
        t: 'lifecycle-unavailable',
        scope,
        unsent: lifecycle.unused(scope, request, authority),
        error:
          (error instanceof Error ? error.message : String(error)).slice(0, 4096) ||
          'Agent lifecycle action failed',
      });
    } catch {
      /* Observe lost replies; never dispatch another lifecycle action. */
    }
  }
}
