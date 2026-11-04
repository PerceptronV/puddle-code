import { expect, it, vi } from 'vitest';
import { startDaemon } from '../../../src/daemon.js';
import * as supervision from '../../../src/host/supervision/inspection.js';
import * as releases from '../../../src/runtime/lifecycle/release.js';
import { PtyManager } from '../../../src/pty/pty-manager.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { sh } from '../../helpers/git-fixtures.js';

it.each(['supervisor', 'installation'] as const)(
  'uses independent ownership by default and never falls back after a missing %s',
  async (missing) => {
    const f = runtimeDatabase();
    f.runtimes.finish(f.binding.runtime_id, 'exited', () =>
      f.sessions.setStatus(f.session.id, 'exited'),
    );
    sh(f.home, 'init', '-b', 'main');
    f.controller.release();
    const manager = vi.spyOn(supervision, 'inspectHostServiceManager');
    if (missing === 'supervisor') manager.mockRejectedValue(new Error('No user manager'));
    else manager.mockResolvedValue({ kind: 'launchd', domain: 'gui/123' });
    const selected = vi.spyOn(releases, 'resolveInstalledRuntimeRelease');
    const spawn = vi.spyOn(PtyManager.prototype, 'spawn');
    // No runtime override, installed service or provider: both failures precede dispatch.
    const daemon = await startDaemon({ home: f.home, port: 0, adapters: [] });
    try {
      const { token } = daemon.authority.create();
      const response = await fetch(`http://127.0.0.1:${daemon.port}/api/sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ project_id: f.project.id, kind: 'terminal', cwd: '.' }),
      });
      expect(response.status).toBe(missing === 'supervisor' ? 503 : 500);
      await response.arrayBuffer();
      expect(manager).toHaveBeenCalledOnce();
      expect(selected).toHaveBeenCalledTimes(missing === 'supervisor' ? 0 : 1);
      expect(spawn).not.toHaveBeenCalled();
      expect(f.runtimes.live()).toEqual([]);
    } finally {
      await daemon.stop();
      await f.reconciler.close();
      f.db.close();
      vi.restoreAllMocks();
    }
  },
);

it('fences a launch whose service-manager probe settles after shutdown starts', async () => {
  const f = runtimeDatabase();
  f.runtimes.finish(f.binding.runtime_id, 'exited', () =>
    f.sessions.setStatus(f.session.id, 'exited'),
  );
  sh(f.home, 'init', '-b', 'main');
  f.controller.release();
  let release!: () => void;
  const probe = new Promise<void>((resolve) => {
    release = resolve;
  });
  const manager = vi
    .spyOn(supervision, 'inspectHostServiceManager')
    .mockImplementation(async () => {
      await probe;
      return { kind: 'launchd', domain: 'gui/123' };
    });
  const selected = vi.spyOn(releases, 'resolveInstalledRuntimeRelease');
  const spawn = vi.spyOn(PtyManager.prototype, 'spawn');
  const daemon = await startDaemon({ home: f.home, port: 0, adapters: [] });
  let stopping: Promise<void> | undefined;
  try {
    const { token } = daemon.authority.create();
    const request = fetch(`http://127.0.0.1:${daemon.port}/api/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: f.project.id, kind: 'terminal', cwd: '.' }),
    }).then(
      async (response) => {
        await response.arrayBuffer();
        return response.ok;
      },
      () => false, // Shutdown may close the socket before the refusal is delivered.
    );
    await vi.waitFor(() => expect(manager).toHaveBeenCalledOnce());
    stopping = daemon.stop();
    release();
    expect(await request).toBe(false);
    await stopping;
    expect(selected).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(f.runtimes.live()).toEqual([]);
  } finally {
    release();
    await (stopping ?? daemon.stop());
    await f.reconciler.close();
    f.db.close();
    vi.restoreAllMocks();
  }
});
