import { setTimeout as delay } from 'node:timers/promises';
import type { HuddleSpawnOperation } from '@puddle/shared';
import type { HuddleAgentSpawns } from '../spawns/service.js';
import type { HuddleDispatchContext } from './context.js';

/** Owner cleanup intent is authority; lost readiness or controller replies alone are not. */
export async function cleanupHuddleSpawn(
  { task, client, current, authority, changed }: HuddleDispatchContext<HuddleSpawnOperation>,
  spawns: HuddleAgentSpawns,
) {
  const { scope, request } = task.operation;
  let settling = false;
  try {
    if (!current() || task.operation.cleanup.state !== 'pending') return;
    const result = await spawns.cancel(scope, request, authority);
    if (!current()) return;
    if (result.state === 'pending') {
      await delay(250);
      if (current()) changed();
      return;
    }
    settling = true;
    const saved = await client.request({ t: 'spawn-cleanup-settle', scope, outcome: result.state });
    if (!current()) return;
    if (
      saved.t !== 'spawn-cleaned' ||
      saved.operationId !== scope.operationId ||
      saved.outcome !== result.state
    )
      throw new Error('Owner did not confirm retained spawn cleanup');
  } catch (error) {
    if (!current()) return;
    if (settling) {
      changed(); // Observe the owner ledger; never infer another stop attempt from a lost reply.
      return;
    }
    try {
      await client.request({
        t: 'spawn-cleanup-unavailable',
        scope,
        error:
          (error instanceof Error ? error.message : String(error)).slice(0, 4096) ||
          'Agent cleanup is unconfirmed',
      });
    } catch {
      /* Retained intent remains pending for the next authorised observation. */
    }
  }
}
