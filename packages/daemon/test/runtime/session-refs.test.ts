import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { runtimePriorRefs } from '../../src/runtime/session-refs.js';
import { SessionRefs } from '../../src/sessions/session-refs.js';
import type { AgentAdapter } from '../../src/agents/adapter.js';
import { runtimeDatabase } from '../helpers/runtime-database.js';
import { runtimeTestAdapter } from '../helpers/runtime-test-adapter.js';

it.each([
  { available: ['old', 'new'], result: 'new', accepted: true },
  { available: ['old', 'new', 'another-new'], result: 'new', accepted: false },
  { available: ['old'], result: 'old', accepted: false },
  { available: ['old', 'new'], result: 'old', accepted: false },
])(
  'uses private launch evidence to refuse ambiguous or pre-existing recovery: $available → $result',
  async ({ available, result, accepted }) => {
    const f = runtimeDatabase('interactive');
    try {
      f.launch.provider!.prior_refs = ['old'];
      atomicPrivateJson(join(f.directory, 'launch.json'), f.launch);
      f.runtimes.finish(f.binding.runtime_id, 'exited', () =>
        f.sessions.setStatus(f.session.id, 'exited'),
      );
      const snapshot = runtimePriorRefs(f.home, f.runtimes, f.session.id);
      expect(snapshot).toEqual(new Set(['old']));
      const discover = vi.fn<NonNullable<AgentAdapter['discoverSessionRef']>>(
        async (_cwd, _account, context) => {
          expect(context?.excludeRefs?.has('old')).toBe(true);
          return result;
        },
      );
      const adapter = {
        ...runtimeTestAdapter,
        existingSessionRefs: async () => new Set(available),
        discoverSessionRef: discover,
      };
      const refs = new SessionRefs(f);
      const resolved = refs.resolveForResume(
        f.sessions.get(f.session.id),
        f.account!,
        adapter,
        snapshot,
      );
      if (accepted) {
        await expect(resolved).resolves.toBe('new');
        expect(f.sessions.get(f.session.id).agent_session_ref).toBe('new');
      } else {
        await expect(resolved).rejects.toMatchObject({ code: 'conversation_missing' });
        expect(f.sessions.get(f.session.id).agent_session_ref).toBeNull();
      }
      f.launch.identity.incarnation = randomUUID();
      atomicPrivateJson(join(f.directory, 'launch.json'), f.launch);
      expect(() => runtimePriorRefs(f.home, f.runtimes, f.session.id)).toThrow('identity changed');
    } finally {
      await f.reconciler.close();
      f.db.close();
    }
  },
);
