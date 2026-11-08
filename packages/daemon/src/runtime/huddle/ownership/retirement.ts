import {
  canonicalHuddleJson,
  huddleOwnerStateSchema,
  runtimeRetiredSchema,
  type HuddleOwnerLaunch,
} from '@puddle/shared';
import type { RuntimeBinding } from '../../../db/stores/runtimes.js';
import { requireHuddleState } from './binding.js';

/** Data evidence only; callers still hold all retirement claims and fence delayed starts. */
export function huddleRetirementState(
  binding: RuntimeBinding,
  launch: HuddleOwnerLaunch,
  rawState: unknown,
  rawConsumed: unknown,
) {
  const state = rawState === null ? null : huddleOwnerStateSchema.parse(rawState);
  if (state) {
    requireHuddleState(launch, state);
    if (state.persistencePending || state.observation < binding.event_cursor)
      throw new Error('Huddle retained observation is incomplete');
  } else if (binding.event_cursor >= 0)
    throw new Error('Previously observed huddle state is missing');
  const consumed = rawConsumed === null ? null : runtimeRetiredSchema.parse(rawConsumed);
  if (consumed && canonicalHuddleJson(consumed.identity) !== canonicalHuddleJson(launch.identity))
    throw new Error('Huddle consumption identity changed');
  const clean =
    state === null
      ? consumed === null
      : state.state === 'exited' &&
        !state.executing &&
        !state.liveWorkers &&
        state.failure === null &&
        state.control.state === 'stopped';
  return { state, consumed, clean };
}
