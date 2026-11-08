import { setTimeout as delay } from 'node:timers/promises';
import {
  canonicalHuddleJson,
  huddleSpawnOutcomeSchema,
  type HuddleSpawnOperation,
  type HuddleSpawnOutcome,
} from '@puddle/shared';
import type { HuddleAgentSpawns } from '../spawns/service.js';
import type { HuddleDispatchContext } from './context.js';

/** A fresh claim permits one creation; all subsequent visits only observe retained host state. */
export async function executeHuddleSpawn(
  { task, client, current, authority, changed }: HuddleDispatchContext<HuddleSpawnOperation>,
  spawns: HuddleAgentSpawns,
) {
  const { scope, request } = task.operation;
  let invoked = false;
  let claiming = false;
  let settling = false;
  const settle = async (raw: HuddleSpawnOutcome) => {
    const result = huddleSpawnOutcomeSchema.parse(raw);
    settling = true;
    const saved = await client.request({ t: 'spawn-settle', scope, result });
    if (!current()) return;
    if (
      saved.t !== 'spawn-settled' ||
      saved.operationId !== scope.operationId ||
      canonicalHuddleJson(saved.result) !== canonicalHuddleJson(result)
    )
      throw new Error('Owner did not confirm its retained spawn outcome');
  };
  try {
    if (task.operation.state === 'completed' || task.operation.state === 'failed') return;
    if (task.operation.state === 'prepared') {
      if (!authority('dispatch')) return;
      claiming = true;
      const claimed = await client.request({ t: 'spawn-claim', operationId: scope.operationId });
      if (!current() || claimed.t !== 'spawn-claim') return;
      if (
        canonicalHuddleJson(claimed.operation.scope) !== canonicalHuddleJson(scope) ||
        canonicalHuddleJson(claimed.operation.request) !== canonicalHuddleJson(request)
      )
        throw new Error('Claim changed the retained spawn');
      task.operation = claimed.operation;
      if (claimed.dispatch) {
        invoked = true;
        await spawns.spawn(scope, request, task.abort.signal, authority);
      }
    }
    for (;;) {
      if (!current()) return;
      const result = spawns.observe(scope, request, authority);
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
      const result = spawns.observe(scope, request, authority);
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
        t: 'spawn-unavailable',
        scope,
        unsent: spawns.unused(scope, request, authority),
        error:
          (error instanceof Error ? error.message : String(error)).slice(0, 4096) ||
          'Agent creation failed',
      });
    } catch {
      /* Observe lost replies; never dispatch another spawn. */
    }
  }
}
