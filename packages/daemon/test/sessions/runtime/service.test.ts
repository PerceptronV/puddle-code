import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { RuntimeState } from '@puddle/shared';
import { SessionRuntimeService } from '../../../src/sessions/runtime/service.js';
import type { RuntimeControls } from '../../../src/runtime/controller/controls.js';
import type {
  RuntimeLauncher,
  RuntimeLaunchGuard,
} from '../../../src/runtime/lifecycle/launcher.js';
import { resolveInstalledRuntimeRelease } from '../../../src/runtime/lifecycle/release.js';
import { AdapterRegistry } from '../../../src/agents/registry.js';
import { AccountStore } from '../../../src/db/stores/accounts.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { runtimeRelease } from '../../helpers/runtime-release.js';

it.each([
  'authority-before-stop',
  'authority-after-stop',
  'release-before-stop',
  'release-after-stop',
  'archive-before-launch',
] as const)('does not start a replacement after %s changes', async (change) => {
  const f = runtimeDatabase();
  const first = runtimeRelease(f.home, '0.4.0');
  const second = runtimeRelease(f.home, '0.4.1');
  first.select();
  let authorised = true;
  let stopping = false;
  const stopped = vi.fn();
  const launched = vi.fn();
  // This fixture tests orchestration around real SQLite/selector state. Controls
  // and supervision have separate live tests; no process is started here.
  const state = {
    identity: f.launch.identity,
    state: 'running',
    persistence_pending: false,
    binding: { session_id: f.session.id, segment_id: f.binding.runtime_id },
    history: {
      current: { id: f.binding.runtime_id, agent_session_ref: null },
      pending_checkpoints: 0,
      gap: false,
    },
    terminals: [{ term: 'agent', generation: randomUUID(), exit_code: null }],
  } as RuntimeState;
  const launcher = {
    selectedRelease: () => resolveInstalledRuntimeRelease(f.home),
    checkAvailable: async () => {
      if (change === 'authority-before-stop') authorised = false;
      if (change === 'release-before-stop') second.select();
    },
  } as unknown as RuntimeLauncher;
  const controls = {
    inspect: async () => state,
    stop: async (_id: string, authority: () => boolean, review: (state: RuntimeState) => void) => {
      expect(authority()).toBe(true);
      review(state);
      stopped();
      stopping = true;
      f.runtimes.finish(f.binding.runtime_id, 'exited', () =>
        f.sessions.setStatus(f.session.id, 'exited'),
      );
      if (change === 'authority-after-stop') authorised = false;
      if (change === 'release-after-stop') second.select();
    },
  } as unknown as RuntimeControls;
  const resume = vi.fn(async (id: string, guard: RuntimeLaunchGuard) => {
    if (change === 'archive-before-launch') f.sessions.setStatus(id, 'archived');
    guard(launcher.selectedRelease());
    launched();
    return f.sessions.get(id);
  });
  const service = new SessionRuntimeService(
    {
      ...f,
      runtimeLauncher: launcher,
      runtimeControls: controls,
      adapters: new AdapterRegistry([]),
      accounts: new AccountStore(f.db),
    },
    resume,
    async () => {},
  );
  try {
    const review = await service.inspect(f.session.id, () => authorised);
    expect(review.restart.available).toBe(true);
    await expect(
      service.restart(
        f.session.id,
        { fingerprint: review.restart.available ? review.restart.fingerprint : '' },
        () => authorised,
      ),
    ).rejects.toBeDefined();
    expect(launched).not.toHaveBeenCalled();
    expect(stopped).toHaveBeenCalledTimes(change.endsWith('before-stop') ? 0 : 1);
    expect(f.runtimes.ownerOf(f.session.id) === null).toBe(stopping);
    if (change === 'archive-before-launch')
      expect(f.sessions.get(f.session.id).status).toBe('archived');
  } finally {
    await f.reconciler.close();
    f.db.close();
  }
});
