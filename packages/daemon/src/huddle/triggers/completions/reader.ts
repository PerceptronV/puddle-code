import { realpathSync } from 'node:fs';
import {
  canonicalHuddleJson,
  huddleCompletionTargetSchema,
  runtimeNativeTurnPageSchema,
  type HuddleCompletionTarget,
  type HuddleCompletionPlan,
  type RuntimeNativeTurnCursor,
} from '@puddle/shared';
import type { RuntimeStore } from '../../../db/stores/runtimes.js';
import type { SessionStore } from '../../../db/stores/sessions.js';
import type { ProjectStore } from '../../../db/stores/projects.js';
import type { RuntimeConnections } from '../../../runtime/transport/connections.js';
import { runtimeBindingIdentity } from '../../../runtime/transport/connections.js';
import type { RuntimeClient } from '../../../runtime/transport/client.js';

type Scope = { profileId: string; projectId: string };
type Selection = HuddleCompletionPlan['sources'][number];
export interface CompletionReaderDependencies {
  runtimes: Pick<RuntimeStore, 'ownerOf' | 'stopRequested'>;
  connections: Pick<RuntimeConnections, 'get'>;
  sessions: Pick<SessionStore, 'get'>;
  projects: Pick<ProjectStore, 'get'>;
}

/** Read-only native observation. No attach, launch, prompt, signal or automatic rebase. */
export class HuddleCompletionReader {
  constructor(private readonly deps: CompletionReaderDependencies) {}

  private check(scope: Scope, target: HuddleCompletionTarget, client: RuntimeClient) {
    const session = this.deps.sessions.get(target.sessionId);
    const project = this.deps.projects.get(scope.projectId);
    const binding = this.deps.runtimes.ownerOf(target.sessionId);
    const state = client.state;
    if (
      project.profile_id !== scope.profileId ||
      project.archived ||
      session.kind !== 'agent' ||
      session.project_id !== scope.projectId ||
      session.status === 'archived' ||
      session.persistence_pending ||
      realpathSync(session.worktree_path) !== target.identity.canonical_worktree_path ||
      session.agent_session_ref !== target.nativeRef ||
      !binding ||
      binding.role !== 'session' ||
      binding.state !== 'running' ||
      binding.profile_id !== scope.profileId ||
      binding.project_id !== scope.projectId ||
      binding.active_session_id !== target.sessionId ||
      binding.active_segment_id !== target.segmentId ||
      canonicalHuddleJson(runtimeBindingIdentity(binding)) !==
        canonicalHuddleJson(target.identity) ||
      this.deps.runtimes.stopRequested(binding.runtime_id) ||
      this.deps.connections.get(binding.runtime_id) !== client ||
      !state ||
      canonicalHuddleJson(state.identity) !== canonicalHuddleJson(target.identity) ||
      state.state !== 'running' ||
      state.persistence_pending ||
      state.protocol.major !== 1 ||
      state.protocol.minor < 2 ||
      state.agent?.native_turn_events !== 1 ||
      state.agent.status === 'exited' ||
      state.agent.agent_session_ref !== target.nativeRef ||
      !state.native_turns ||
      state.binding?.session_id !== target.sessionId ||
      state.binding.segment_id !== target.segmentId ||
      state.history.current.id !== target.segmentId ||
      state.history.current.agent_session_ref !== target.nativeRef
    )
      throw new Error('Completion target changed or lacks exact native observation support');
    return state;
  }

  async capture(scope: Scope, selection: Selection, guard: () => void) {
    guard();
    const binding = this.deps.runtimes.ownerOf(selection.session);
    const client = binding && this.deps.connections.get(binding.runtime_id);
    if (!binding || !client?.state || binding.canonical_worktree_path !== selection.worktree)
      throw new Error(
        'Selected completion agent has no connected runtime in its declared worktree',
      );
    const target = huddleCompletionTargetSchema.parse({
      identity: runtimeBindingIdentity(binding),
      sessionId: selection.session,
      segmentId: binding.active_segment_id,
      nativeRef: client.state.agent?.agent_session_ref,
    });
    const captured = await this.read(scope, target, null, guard, client);
    if (captured.page.state !== 'baseline')
      throw new Error('Completion source did not return a baseline');
    return {
      baseline: { node: selection.node, target, cursor: captured.page.cursor },
      check: captured.check,
    };
  }

  async read(
    scope: Scope,
    target: HuddleCompletionTarget,
    after: RuntimeNativeTurnCursor | null,
    guard: () => void,
    pinned?: RuntimeClient,
  ) {
    const client = pinned ?? this.deps.connections.get(target.identity.runtime_id);
    if (!client) throw new Error('Completion target is disconnected');
    const check = () => {
      guard();
      return this.check(scope, target, client);
    };
    check();
    const before = await client.request({ t: 'inspect' });
    check();
    if (before.t !== 'state') throw new Error('Completion target inspection failed');
    const result = await client.request({ t: 'native-turns', after });
    check();
    if (result.t !== 'native-turns') throw new Error('Completion source read failed');
    const page = runtimeNativeTurnPageSchema.parse(result.page);
    if (page.persistencePending) throw new Error('Completion source persistence is pending');
    const inspected = await client.request({ t: 'inspect' });
    check();
    if (inspected.t !== 'state') throw new Error('Completion target reinspection failed');
    const finalCheck = () => {
      const state = check();
      if (
        state.native_turns!.cursor.epoch !== page.cursor.epoch ||
        state.native_turns!.cursor.sequence < page.cursor.sequence
      )
        throw new Error('Completion source changed during observation');
    };
    finalCheck();
    return { page, check: finalCheck };
  }
}
