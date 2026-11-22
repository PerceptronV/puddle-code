import {
  canonicalHuddleJson,
  type HostUpdateAdoption,
  type HostUpdateReview,
} from '@puddle/shared';
import type { RuntimeStore } from '../../db/stores/runtimes.js';
import type { RuntimeReconciler } from '../../runtime/controller/reconcile.js';
import {
  runtimeBindingIdentity,
  type RuntimeConnections,
} from '../../runtime/transport/connections.js';
import { huddleBindingLaunch, requireHuddleState } from '../../runtime/huddle/ownership/binding.js';
import { runtimeCheckpointOwner } from './store.js';
import type { readUpdateAdoptionRequirements } from './requirements.js';
import { adoptionBlocked, HostUpdateVerificationBlocked } from '../verification/diagnostics.js';

/** The same owner checks produce proof or bounded diagnostics; diagnostics never relax adoption. */
export function inspectAdoptionOwners(
  deps: {
    home: string;
    runtimes: Pick<RuntimeStore, 'get'>;
    connections: Pick<RuntimeConnections, 'get'> & Partial<Pick<RuntimeConnections, 'getHuddle'>>;
    reconciler: Pick<RuntimeReconciler, 'settled'>;
  },
  expectedOwners: ReturnType<typeof readUpdateAdoptionRequirements>['owners'],
): HostUpdateAdoption['owners'] {
  const blockers: HostUpdateReview['blockers'] = [];
  let more = 0;
  const owners: HostUpdateAdoption['owners'] = [];
  for (const expected of expectedOwners) {
    const id = expected.identity.runtime_id;
    try {
      const row = deps.runtimes.get(id);
      if (!row) adoptionBlocked('runtime_unavailable', id);
      const identity = runtimeBindingIdentity(row);
      if (
        Object.entries(expected.identity).some(
          ([key, value]) => identity[key as keyof typeof identity] !== value,
        ) ||
        canonicalHuddleJson(runtimeCheckpointOwner(row).huddle ?? null) !==
          canonicalHuddleJson(expected.huddle ?? null) ||
        row.launch_fingerprint !== expected.launch_fingerprint ||
        row.release_path !== expected.release_path ||
        row.build !== expected.build ||
        row.protocol_major !== expected.protocol.major ||
        row.protocol_minor !== expected.protocol.minor ||
        row.event_cursor < Math.max(0, expected.event_cursor) ||
        expected.state === 'interrupted' ||
        (['exited', 'failed'].includes(expected.state) && expected.state !== row.state) ||
        (row.state !== 'running' && row.state !== 'exited' && row.state !== 'failed')
      )
        adoptionBlocked('runtime_adoption_changed', id);
      if (row.state === 'running' && row.role === 'huddle') {
        const state = deps.connections.getHuddle?.(id)?.state;
        if (!state) adoptionBlocked('runtime_unavailable', id);
        if (state.persistencePending) adoptionBlocked('runtime_persistence_pending', id);
        if (state.state !== 'running' || state.observation < row.event_cursor)
          adoptionBlocked('runtime_adoption_changed', id);
        try {
          requireHuddleState(huddleBindingLaunch(deps.home, row), state);
        } catch {
          adoptionBlocked('runtime_adoption_changed', id);
        }
      } else if (row.state === 'running') {
        const state = deps.connections.get(id)?.state;
        if (!state) adoptionBlocked('runtime_unavailable', id);
        if (state.persistence_pending || state.journal.persistence_pending)
          adoptionBlocked('runtime_persistence_pending', id);
        if (
          state.state !== 'running' ||
          state.journal.lost_through > row.event_cursor ||
          Object.entries(identity).some(
            ([key, value]) => state.identity[key as keyof typeof identity] !== value,
          ) ||
          state.build !== row.build ||
          state.protocol.major !== row.protocol_major ||
          state.protocol.minor !== row.protocol_minor ||
          state.binding?.session_id !== row.active_session_id ||
          state.binding.segment_id !== row.active_segment_id
        )
          adoptionBlocked('runtime_adoption_changed', id);
      } else if (deps.connections.get(id) || deps.connections.getHuddle?.(id)) {
        // A final row is not enough while an old owner connection still exists.
        adoptionBlocked('runtime_adoption_changed', id);
      }
      if (!deps.reconciler.settled(id)) adoptionBlocked('runtime_reconciliation_pending', id);
      owners.push({
        runtime_id: id,
        event_cursor: row.event_cursor,
        state: row.state,
      });
    } catch (error) {
      if (!(error instanceof HostUpdateVerificationBlocked)) throw error;
      if (blockers.length < 32) blockers.push(...error.blockers);
      else more++;
    }
  }
  if (blockers.length) throw new HostUpdateVerificationBlocked(blockers, more);
  return owners;
}
