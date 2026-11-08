import { expect, it, vi } from 'vitest';
import { decodeHuddleLifecycleTarget } from '@puddle/shared';
import { HuddleAgentLifecycle } from '../../../../src/huddle/operations/lifecycle/service.js';
import { resolveHuddleAgent } from '../../../../src/huddle/execution/agents.js';
import { huddleSpawnServiceFixture } from '../../../helpers/huddle/spawn-service.js';
import { until } from '../../../helpers/huddle/controller.js';

it.each(['resume', 'restart'] as const)(
  '%s reuses normal session controls and retains one replacement after a lost result',
  async (action) => {
    const f = huddleSpawnServiceFixture();
    try {
      f.sessions.setAgentSessionRef(f.session.id, 'fixture-conversation');
      if (action === 'restart') await f.service.resume(f.session.id);
      const before = f.run.mock.calls.length;
      const target = decodeHuddleLifecycleTarget(
        resolveHuddleAgent(
          { sessions: f.sessions, runtimes: f.runtimes, turns: f.deps.turns },
          f.profile.id,
          f.project.id,
          f.session.id,
          f.request.worktree,
          action,
        ),
      );
      const deps = {
        db: f.db,
        sessions: f.sessions,
        runtimes: f.runtimes,
        service: f.service,
        turns: f.deps.turns,
        adapters: f.deps.adapters,
      };
      const lifecycle = new HuddleAgentLifecycle(deps);
      const request = { action, target };
      await lifecycle.execute(f.scope, request, () => true);
      const replacement = new HuddleAgentLifecycle(deps);
      await until(() => !!replacement.observe(f.scope, request, () => true));
      const result = replacement.observe(f.scope, request, () => true)!;
      expect(result.agent.sessionId).toBe(f.session.id);
      expect(result.agent.runtimeId).not.toBe(target.runtime?.runtimeId);
      expect(f.run.mock.calls.length).toBe(before + 1);
      expect(f.sessions.get(f.session.id).agent_session_ref).toBe('fixture-conversation');
      await expect(replacement.execute(f.scope, request, () => true)).rejects.toThrow();
      expect(f.run.mock.calls.length).toBe(before + 1);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM huddle_runtime_spawns').get()).toEqual({
        n: 0,
      });
      await f.controls.stop(f.session.id, () => true);
      expect(replacement.observe(f.scope, request, () => true)).toEqual(result);
    } finally {
      await f.close();
    }
  },
);

it('keeps an unlaunched lifecycle attempt out of boot auto-resume until a separate explicit launch', async () => {
  const f = huddleSpawnServiceFixture();
  try {
    f.sessions.setAgentSessionRef(f.session.id, 'fixture-conversation');
    const target = decodeHuddleLifecycleTarget(
      resolveHuddleAgent(
        { sessions: f.sessions, runtimes: f.runtimes, turns: f.deps.turns },
        f.profile.id,
        f.project.id,
        f.session.id,
        f.request.worktree,
        'resume',
      ),
    );
    const lifecycle = new HuddleAgentLifecycle({
      db: f.db,
      sessions: f.sessions,
      runtimes: f.runtimes,
      service: f.service,
      turns: f.deps.turns,
      adapters: f.deps.adapters,
    });
    const request = { action: 'resume' as const, target };
    const call = vi
      .spyOn(f.service, 'resumeForCaller')
      .mockRejectedValue(new Error('Lost before launch'));
    await expect(lifecycle.execute(f.scope, request, () => true)).rejects.toThrow(
      'Lost before launch',
    );
    expect(lifecycle.unused(f.scope, request, () => true)).toBe(false);
    expect(f.runtimes.unstartedHuddleSessions().has(f.session.id)).toBe(true);
    await expect(lifecycle.execute(f.scope, request, () => true)).rejects.toThrow(
      'already attempted',
    );
    expect(call).toHaveBeenCalledOnce();
    call.mockRestore();
    await f.service.resume(f.session.id);
    expect(f.runtimes.unstartedHuddleSessions().has(f.session.id)).toBe(false);
    expect(lifecycle.observe(f.scope, request, () => true)).toBeNull();
    await f.controls.stop(f.session.id, () => true);
  } finally {
    await f.close();
  }
});
