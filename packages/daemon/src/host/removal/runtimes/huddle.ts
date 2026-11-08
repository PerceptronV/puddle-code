import { canonicalHuddleJson, type HuddleOwnerState } from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import type { RuntimeBinding } from '../../../db/stores/runtimes.js';
import { runtimeBindingIdentity } from '../../../runtime/transport/connections.js';
import { removalRuntimeInventory, type RuntimeRemovalOwner } from './inspection.js';

/** Review stops this exact owner and all work admitted under its current activation. */
export function inspectHuddleRemoval(
  owner: RuntimeBinding,
  state: HuddleOwnerState | null,
  requested: boolean,
): RuntimeRemovalOwner {
  let reason: 'unavailable' | 'unsaved' | 'stop_pending' | null = null;
  if (requested) reason = 'stop_pending';
  else if (
    !state ||
    owner.role !== 'huddle' ||
    state.state !== 'running' ||
    owner.active_session_id !== owner.launch_session_id ||
    owner.active_segment_id !== null ||
    canonicalHuddleJson(state.identity) !== canonicalHuddleJson(runtimeBindingIdentity(owner)) ||
    state.scope.huddleId !== owner.huddle_id ||
    state.scope.sessionId !== owner.active_session_id ||
    state.scope.profileId !== owner.profile_id ||
    state.scope.projectId !== owner.project_id ||
    state.build !== owner.build ||
    canonicalHuddleJson(state.capabilities) !==
      canonicalHuddleJson(JSON.parse(owner.huddle_capabilities ?? 'null'))
  )
    reason = 'unavailable';
  else if (state.persistencePending || state.observation < owner.event_cursor) reason = 'unsaved';
  return {
    id: owner.runtime_id,
    session: owner.active_session_id,
    version: owner.build,
    release: owner.release_path,
    terminals: [],
    stop: reason
      ? { reason }
      : {
          fingerprint: digest(
            canonicalHuddleJson({
              owner: removalRuntimeInventory([owner]),
              control: state!.control,
              executing: state!.executing,
              liveWorkers: state!.liveWorkers,
              failure: state!.failure,
            }),
          ),
        },
  };
}
