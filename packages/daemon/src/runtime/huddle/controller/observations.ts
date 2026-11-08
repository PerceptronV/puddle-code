import type { HuddleOwnerState } from '@puddle/shared';
import { ApiError } from '../../../http/errors.js';

export interface HuddleOwnerTarget {
  runtimeId: string;
  incarnation: string;
}

/** Activation ids retain both the captured revision and its resolved bindings. */
export interface HuddleControlTarget extends HuddleOwnerTarget {
  generation: number;
  activationId: string | null;
}

export function huddleControlTarget(state: HuddleOwnerState): HuddleControlTarget {
  return {
    runtimeId: state.identity.runtime_id,
    incarnation: state.identity.incarnation,
    generation: state.control.generation,
    activationId: state.control.activationId,
  };
}

export function requireHuddleControl(state: HuddleOwnerState, expected: HuddleControlTarget) {
  const current = huddleControlTarget(state);
  if (
    current.runtimeId !== expected.runtimeId ||
    current.incarnation !== expected.incarnation ||
    current.generation !== expected.generation ||
    current.activationId !== expected.activationId
  )
    throw ApiError.conflict(
      'huddle_control_changed',
      'The huddle activation or lifecycle changed; inspect it before another command',
    );
}
