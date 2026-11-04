import { describe, expect, it, vi } from 'vitest';
import { SessionRefs } from '../../src/sessions/session-refs.js';
import { runtimeDatabase } from '../helpers/runtime-database.js';
import { runtimeTestAdapter } from '../helpers/runtime-test-adapter.js';

describe('native-ref shutdown', () => {
  it.each([true, false])(
    'commits a started capture before closing (preset id: %s)',
    async (presetSessionId) => {
      const f = runtimeDatabase('interactive');
      const refs = new SessionRefs(f);
      let release!: (ref: string) => void;
      const native = new Promise<string>((resolve) => {
        release = resolve;
      });
      const adapter = {
        ...runtimeTestAdapter,
        capabilities: { ...runtimeTestAdapter.capabilities, presetSessionId },
        existingSessionRefs: async () => new Set<string>(),
        resolveSessionRef: vi.fn(() => native),
      };
      const spawn = vi.fn(async () => {});
      const captured = vi.fn();
      const failed = vi.fn();
      const launchOpts = { sessionId: f.session.id, worktreePath: f.home, skipPermissions: false };
      const launch = refs.launchAndCapture(
        f.session,
        f.account!,
        adapter,
        launchOpts,
        spawn,
        captured,
        failed,
      );
      try {
        await vi.waitFor(() => expect(adapter.resolveSessionRef).toHaveBeenCalledOnce());
        const closed = vi.fn();
        const closing = refs.close().then(closed);
        await Promise.resolve();
        expect(closed).not.toHaveBeenCalled();
        release('exact-native-ref');
        await launch;
        await closing;
        expect(f.sessions.get(f.session.id).agent_session_ref).toBe('exact-native-ref');
        expect(failed).not.toHaveBeenCalled();
        expect(captured).toHaveBeenCalledTimes(presetSessionId ? 0 : 1);
        await expect(
          refs.launchAndCapture(
            f.session,
            f.account!,
            adapter,
            launchOpts,
            spawn,
            captured,
            failed,
          ),
        ).rejects.toMatchObject({ code: 'host_maintenance' });
        expect(spawn).toHaveBeenCalledOnce();
      } finally {
        release('exact-native-ref');
        await launch;
        await refs.close();
        await f.reconciler.close();
        f.db.close();
      }
    },
  );

  it('refuses delayed spawn after taking a native-store snapshot', async () => {
    const f = runtimeDatabase('interactive');
    const refs = new SessionRefs(f);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = {
      ...runtimeTestAdapter,
      capabilities: { ...runtimeTestAdapter.capabilities, presetSessionId: false },
      existingSessionRefs: vi.fn(async () => {
        await blocked;
        return new Set<string>();
      }),
    };
    const spawn = vi.fn(async () => {});
    const failed = vi.fn();
    try {
      await refs.launchAndCapture(
        f.session,
        f.account!,
        adapter,
        { sessionId: f.session.id, worktreePath: f.home, skipPermissions: false },
        spawn,
        vi.fn(),
        failed,
      );
      await vi.waitFor(() => expect(adapter.existingSessionRefs).toHaveBeenCalledOnce());
      const closing = refs.close();
      release();
      await closing;
      expect(spawn).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'host_maintenance' }),
        'spawn',
      );
      expect(f.sessions.get(f.session.id).agent_session_ref).toBeNull();
    } finally {
      release();
      await refs.close();
      await f.reconciler.close();
      f.db.close();
    }
  });

  it('drains a coalesced late capture and refuses new background discovery', async () => {
    const f = runtimeDatabase('interactive');
    const refs = new SessionRefs(f);
    let release!: (ref: string) => void;
    const native = new Promise<string>((resolve) => {
      release = resolve;
    });
    const adapter = {
      ...runtimeTestAdapter,
      capabilities: { ...runtimeTestAdapter.capabilities, presetSessionId: false },
      discoverSessionRef: vi.fn(() => native),
      sessionRefMatches: async () => true,
    };
    const refresh = refs.refreshAvailable(f.session, f.account!, adapter);
    try {
      expect(refs.refreshAvailable(f.session, f.account!, adapter)).toBe(refresh);
      await vi.waitFor(() => expect(adapter.discoverSessionRef).toHaveBeenCalledOnce());
      const closed = vi.fn();
      const closing = refs.close().then(closed);
      await expect(refs.refreshAvailable(f.session, f.account!, adapter)).resolves.toBe(false);
      expect(closed).not.toHaveBeenCalled();
      release('late-native-ref');
      await expect(refresh).resolves.toBe(true);
      await closing;
      expect(f.sessions.get(f.session.id).agent_session_ref).toBe('late-native-ref');
      expect(adapter.discoverSessionRef).toHaveBeenCalledOnce();
    } finally {
      release('late-native-ref');
      await refresh;
      await refs.close();
      await f.reconciler.close();
      f.db.close();
    }
  });
});
