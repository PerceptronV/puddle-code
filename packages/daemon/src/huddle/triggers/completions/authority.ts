import { realpathSync } from 'node:fs';
import {
  canonicalHuddleJson,
  completionHuddleTrigger,
  type HuddleCompletionSource,
} from '@puddle/shared';
import type { RuntimeBinding } from '../../../db/stores/runtimes.js';
import type { HuddleOwnerClient } from '../../../runtime/huddle/transport/client.js';
import { runtimeBindingIdentity } from '../../../runtime/transport/connections.js';
import { HuddleRevisionStore } from '../../../runtime/huddle/state/revisions.js';
import { requireHuddleDefinitionLocation } from '../../definitions/location.js';
import type { CompletionReaderDependencies } from './reader.js';

export function requireCompletionOwner(
  binding: RuntimeBinding,
  client: HuddleOwnerClient,
  source: HuddleCompletionSource,
  deps: Pick<CompletionReaderDependencies, 'sessions' | 'projects'>,
) {
  const state = client.state;
  if (
    binding.role !== 'huddle' ||
    !binding.huddle_id ||
    binding.state !== 'running' ||
    !state ||
    state.capabilities.completionEvents !== 1 ||
    canonicalHuddleJson(state.identity) !== canonicalHuddleJson(runtimeBindingIdentity(binding)) ||
    state.scope.huddleId !== binding.huddle_id ||
    state.scope.sessionId !== binding.active_session_id ||
    source.target.identity.profile_id !== binding.profile_id ||
    source.target.identity.project_id !== binding.project_id ||
    source.target.sessionId === binding.active_session_id ||
    source.target.identity.runtime_id === binding.runtime_id
  )
    throw new Error('Completion subscription differs from its authenticated owner scope');
  const project = deps.projects.get(binding.project_id),
    session = deps.sessions.get(binding.active_session_id);
  if (
    project.profile_id !== binding.profile_id ||
    project.archived ||
    session.project_id !== binding.project_id ||
    session.kind !== 'huddle' ||
    session.huddle_id !== binding.huddle_id ||
    session.status === 'archived' ||
    realpathSync(session.worktree_path) !== binding.canonical_worktree_path
  )
    throw new Error('Completion owner project/session is unavailable');
  requireHuddleDefinitionLocation(binding.canonical_worktree_path, binding.huddle_id);
  return { profileId: binding.profile_id, projectId: binding.project_id };
}

export function requireCompletionNode(
  home: string,
  binding: RuntimeBinding,
  source: HuddleCompletionSource,
) {
  const snapshot = new HuddleRevisionStore(home, binding.runtime_id, binding.huddle_id!).read(
    source.revision,
  );
  const node = snapshot.definition.nodes.find((node) => node.id === source.node);
  if (
    node?.source.kind !== 'builtin' ||
    node.source.component !== completionHuddleTrigger.id ||
    node.source.version !== 1
  )
    throw new Error('Retained node did not declare native completion observation');
}
