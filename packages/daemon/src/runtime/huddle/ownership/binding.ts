import { join } from 'node:path';
import {
  canonicalHuddleJson,
  huddleOwnerLaunchSchema,
  supportsHuddleRuntime,
  type HuddleOwnerLaunch,
  type HuddleOwnerState,
} from '@puddle/shared';
import type { RuntimeBinding } from '../../../db/stores/runtimes.js';
import { readRuntimeJson, runtimeDirectory } from '../../ownership/storage.js';

export function huddleBindingLaunch(home: string, binding: RuntimeBinding): HuddleOwnerLaunch {
  const directory = runtimeDirectory(home, binding.runtime_id);
  return requireHuddleBindingLaunch(binding, readRuntimeJson(join(directory, 'launch.json')));
}

export function requireHuddleBindingLaunch(
  binding: RuntimeBinding,
  raw: unknown,
): HuddleOwnerLaunch {
  const launch = huddleOwnerLaunchSchema.parse(raw);
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
