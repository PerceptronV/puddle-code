import { expect, it } from 'vitest';
import type { Session } from '@puddle/shared';
import type { RuntimeBinding } from '../../../../src/db/stores/runtimes.js';
import { HuddleCompletionBaselines } from '../../../../src/huddle/triggers/completions/baselines.js';
import { completionOwnerFixture } from '../../../helpers/huddle/completion-owner.js';
import { completionReaderFixture } from '../../../helpers/huddle/completion-reader.js';

it('captures a real owner plan against its live host scope and arms only the verified target', async () => {
  const owner = await completionOwnerFixture(),
    native = completionReaderFixture();
  try {
    const scope = owner.launch.scope,
      identity = owner.launch.identity;
    Object.assign(native.state.identity, {
      profile_id: scope.profileId,
      project_id: scope.projectId,
      canonical_worktree_path: owner.home,
    });
    Object.assign(native.binding, {
      profile_id: scope.profileId,
      project_id: scope.projectId,
      canonical_worktree_path: owner.home,
      active_session_id: owner.baseline.target.sessionId,
    });
    Object.assign(native.session, {
      id: owner.baseline.target.sessionId,
      project_id: scope.projectId,
      worktree_path: owner.home,
    });
    native.state.binding!.session_id = native.session.id;
    Object.assign(native.project, { id: scope.projectId, profile_id: scope.profileId });
    const huddle = {
      id: scope.sessionId,
      kind: 'huddle',
      huddle_id: scope.huddleId,
      project_id: scope.projectId,
      worktree_path: owner.home,
      status: 'running',
    } as Session;
    const binding = {
      role: 'huddle',
      state: 'running',
      huddle_id: scope.huddleId,
      runtime_id: identity.runtime_id,
      incarnation: identity.incarnation,
      launch_id: identity.launch_id,
      launch_session_id: identity.session_id,
      active_session_id: identity.session_id,
      profile_id: identity.profile_id,
      project_id: identity.project_id,
      canonical_worktree_path: owner.home,
    } as RuntimeBinding;
    const captures = new HuddleCompletionBaselines({
      ...native.deps,
      sessions: { get: (id) => (id === huddle.id ? huddle : native.session) },
      runtimes: {
        ...native.deps.runtimes,
        ownerOf: (id) => (id === huddle.id ? binding : native.binding),
      },
      connections: { ...native.deps.connections, getHuddle: () => owner.client },
    });
    const state = owner.client.state!;
    const captured = await captures.capture(owner.client, state, undefined, () => {});
    expect(captured.baselines).toHaveLength(1);
    expect(captured.baselines[0]!.target.identity).toEqual(native.state.identity);
    captured.check();
    await owner.client.request({
      t: 'arm',
      expectedGeneration: state.control.generation,
      autoStart: false,
      completionBaselines: captured.baselines,
    });
    expect((await owner.sources())[0]!.target).toEqual(captured.baselines[0]!.target);
    // The previous review cannot be reused after arming changes its generation.
    expect(() => captured.check()).toThrow('activation or lifecycle changed');
    await owner.client.request({ t: 'interrupt' });
    const fresh = await captures.capture(owner.client, owner.client.state!, undefined, () => {});
    native.deps.runtimes.stopRequested.mockReturnValue(true);
    expect(() => fresh.check()).toThrow('Completion source or owner changed');
    await expect(
      captures.capture(owner.client, owner.client.state!, undefined, () => {}),
    ).rejects.toMatchObject({ code: 'huddle_completion_unavailable', status: 409 });
    await owner.client.request({ t: 'shutdown' });
  } finally {
    native.close();
  }
});
