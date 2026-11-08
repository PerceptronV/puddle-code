import { join } from 'node:path';
import {
  canonicalHuddleJson,
  huddleOwnerLaunchSchema,
  huddleOwnerStateSchema,
  runtimeRetiredSchema,
  supportsHuddleRuntime,
  type HuddleOwnerLaunch,
  type HuddleOwnerState,
  type RuntimeControllerRecord,
} from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import type { RuntimeBinding } from '../../../db/stores/runtimes.js';
import { HostClaimBusy } from '../../../security/claims.js';
import { acquireRuntimeRetirementClaims } from '../../ownership/retirement-claims.js';
import { readRuntimeJson, runtimeDirectory } from '../../ownership/storage.js';
import { retireRuntimeMemoryGrant } from '../../resources/host/retirement.js';
import { HuddleOwnerClient } from '../transport/client.js';

export function huddleBindingLaunch(home: string, binding: RuntimeBinding): HuddleOwnerLaunch {
  const directory = runtimeDirectory(home, binding.runtime_id);
  const launch = huddleOwnerLaunchSchema.parse(readRuntimeJson(join(directory, 'launch.json')));
  const identity = launch.identity;
  if (
    binding.role !== 'huddle' ||
    binding.active_session_id !== binding.launch_session_id ||
    binding.active_segment_id !== null ||
    binding.account_id !== null ||
    binding.agent_type !== null ||
    binding.conversation_id !== null ||
    identity.runtime_id !== binding.runtime_id ||
    identity.incarnation !== binding.incarnation ||
    identity.launch_id !== binding.launch_id ||
    identity.profile_id !== binding.profile_id ||
    identity.project_id !== binding.project_id ||
    identity.session_id !== binding.launch_session_id ||
    identity.canonical_worktree_path !== binding.canonical_worktree_path ||
    launch.scope.huddleId !== binding.huddle_id ||
    launch.build !== binding.build ||
    !binding.huddle_capabilities ||
    !supportsHuddleRuntime(launch.capabilities) ||
    canonicalHuddleJson(launch.capabilities) !==
      canonicalHuddleJson(JSON.parse(binding.huddle_capabilities))
  )
    throw new Error('Huddle launch differs from its committed binding');
  return launch;
}

export function requireHuddleState(launch: HuddleOwnerLaunch, state: HuddleOwnerState): void {
  if (
    canonicalHuddleJson(state.identity) !== canonicalHuddleJson(launch.identity) ||
    canonicalHuddleJson(state.scope) !== canonicalHuddleJson(launch.scope) ||
    canonicalHuddleJson(state.capabilities) !== canonicalHuddleJson(launch.capabilities) ||
    state.build !== launch.build ||
    state.contract !== launch.contract ||
    state.lifetime !== launch.lifetime
  )
    throw new Error('Huddle observation differs from its committed launch');
}

export async function connectHuddleOwner(
  home: string,
  binding: RuntimeBinding,
  controller: RuntimeControllerRecord,
) {
  return HuddleOwnerClient.open(home, huddleBindingLaunch(home, binding), controller);
}

/** Absence requires all launch/owner claims; an IPC failure alone never releases a placement. */
export function retireMissingHuddle(
  home: string,
  binding: RuntimeBinding,
  apply: (state: HuddleOwnerState | null, clean: boolean) => void,
): boolean {
  let claims: ReturnType<typeof acquireRuntimeRetirementClaims>;
  try {
    claims = acquireRuntimeRetirementClaims(home, binding.runtime_id);
  } catch (error) {
    if (error instanceof HostClaimBusy) return false;
    throw error;
  }
  try {
    const launch = huddleBindingLaunch(home, binding);
    const directory = runtimeDirectory(home, binding.runtime_id);
    let state: HuddleOwnerState | null = null;
    try {
      state = huddleOwnerStateSchema.parse(readRuntimeJson(join(directory, 'huddle-owner.json')));
      requireHuddleState(launch, state);
      if (state.persistencePending || state.observation < binding.event_cursor)
        throw new Error('Huddle retained observation is incomplete');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (binding.event_cursor >= 0)
        throw new Error('Previously observed huddle state is missing', { cause: error });
    }
    let neverConsumed = false;
    if (state === null) {
      try {
        const consumed = runtimeRetiredSchema.parse(
          readRuntimeJson(join(directory, 'consumed.json')),
        );
        if (canonicalHuddleJson(consumed.identity) !== canonicalHuddleJson(launch.identity))
          throw new Error('Huddle consumption identity changed');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // No worker can start before consumption. The claims plus the fence below
        // exclude active and delayed starts, including an uncertain dispatcher.
        neverConsumed = true;
      }
    }
    const clean =
      neverConsumed ||
      (state !== null &&
        state.state === 'exited' &&
        !state.executing &&
        !state.liveWorkers &&
        state.failure === null &&
        state.control.state === 'stopped');
    const file = join(directory, 'retired.json');
    try {
      const retired = runtimeRetiredSchema.parse(readRuntimeJson(file));
      if (canonicalHuddleJson(retired.identity) !== canonicalHuddleJson(launch.identity))
        throw new Error('Huddle retirement identity changed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      atomicPrivateJson(file, { format: 1, identity: launch.identity }, { syncDirectory: true });
    }
    // An absent parent does not prove its script descendants have ended.
    if (clean) retireRuntimeMemoryGrant(home, launch.identity, claims);
    apply(state, clean);
    return true;
  } finally {
    claims.release();
  }
}
