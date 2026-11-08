import { realpathSync } from 'node:fs';
import {
  canonicalHuddleJson,
  sessionHuddleTrigger,
  type HuddleSessionSource,
} from '@puddle/shared';
import type { RuntimeBinding } from '../../../db/stores/runtimes.js';
import type { SessionStore } from '../../../db/stores/sessions.js';
import type { ProjectStore } from '../../../db/stores/projects.js';
import type { HuddleOwnerClient } from '../../../runtime/huddle/transport/client.js';
import { runtimeBindingIdentity } from '../../../runtime/transport/connections.js';
import { HuddleRevisionStore } from '../../../runtime/huddle/state/revisions.js';
import { requireHuddleDefinitionLocation } from '../../definitions/location.js';

export function validateSessionSubscription(
  home: string,
  binding: RuntimeBinding,
  client: HuddleOwnerClient,
  source: HuddleSessionSource,
  sessions: Pick<SessionStore, 'get'>,
  projects: Pick<ProjectStore, 'get'>,
) {
  if (
    binding.role !== 'huddle' ||
    client.state?.capabilities.sessionEvents !== 1 ||
    canonicalHuddleJson(client.state.identity) !==
      canonicalHuddleJson(runtimeBindingIdentity(binding)) ||
    source.scope.profileId !== binding.profile_id ||
    source.scope.projectId !== binding.project_id ||
    source.scope.excludeSessionId !== binding.active_session_id ||
    source.scope.kinds.some((kind) => kind === 'huddle')
  )
    throw new Error('Session subscription differs from its authenticated owner scope');
  const project = projects.get(binding.project_id),
    owner = sessions.get(binding.active_session_id);
  if (
    project.profile_id !== binding.profile_id ||
    project.archived ||
    owner.status === 'archived' ||
    owner.kind !== 'huddle'
  )
    throw new Error('Huddle project/session is unavailable');
  requireHuddleDefinitionLocation(binding.canonical_worktree_path, binding.huddle_id!);
  if (realpathSync(source.scope.worktree) !== source.scope.worktree)
    throw new Error('Session observation worktree moved');
  if (source.scope.sessionId) {
    const target = sessions.get(source.scope.sessionId);
    if (
      target.project_id !== binding.project_id ||
      target.kind === 'huddle' ||
      realpathSync(target.worktree_path) !== source.scope.worktree
    )
      throw new Error('Observed session left its declared project/worktree');
  }
  const snapshot = new HuddleRevisionStore(home, binding.runtime_id, binding.huddle_id!).read(
    source.revision,
  );
  const node = snapshot.definition.nodes.find((node) => node.id === source.node);
  if (
    node?.source.kind !== 'builtin' ||
    node.source.component !== sessionHuddleTrigger.id ||
    node.source.version !== 1
  )
    throw new Error('Retained node did not declare session observation');
}
