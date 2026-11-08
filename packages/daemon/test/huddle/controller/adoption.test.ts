import { once } from 'node:events';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { launchOwner } from '../../helpers/runtime-fixture.js';
import { HostMemoryLedger } from '../../../src/runtime/resources/host/ledger.js';
import { RuntimeServiceCleanupStore } from '../../../src/db/stores/runtime-service-cleanup.js';

import { huddleControllerFixture as fixture, until } from '../../helpers/huddle/controller.js';

it('adopts both roles, observes controllerless completion and retires only after exact clean exit', async () => {
  const f = await fixture();
  try {
    expect(f.connections.get(f.binding.runtime_id)).toBeNull();
    expect(f.connections.get(f.ordinaryRuntimeId)).not.toBeNull();
    expect(f.connections.getHuddle(f.ordinaryRuntimeId)).toBeNull();
    expect(f.connections.getHuddle(f.launch.identity.runtime_id)).toBe(f.client);
    expect(f.sessions.get(f.session.id).status).toBe('exited');
    await f.run();
    await until(() => f.sessions.get(f.session.id).status === 'running');
    const before = f.runtimes.get(f.binding.runtime_id)!.event_cursor;
    expect(await f.reconciler.retire(f.binding.runtime_id)).toBe(false);
    await f.disconnect();
    writeFileSync(join(f.home, 'release'), 'go');
    await until(() => existsSync(join(f.home, 'completed')));
    await f.replace();
    expect(f.runtimes.get(f.binding.runtime_id)!.event_cursor).toBeGreaterThan(before);
    expect(f.client.state).toMatchObject({ executing: false, control: { state: 'armed' } });
    expect(readFileSync(join(f.home, 'entered'), 'utf8')).toBe('x');
    expect(f.connections.unavailableIds()).toEqual([]);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM runtime_segments').get()).toEqual({
      count: 1,
    });
    const exited = once(f.owner.child, 'exit');
    await f.client.request({ t: 'shutdown' });
    await exited;
    await f.connections.connect();
    await until(() => f.runtimes.get(f.binding.runtime_id)!.state === 'exited');
    expect(f.sessions.get(f.session.id).status).toBe('exited');
    expect(f.runtimes.ownerOf(f.session.id)).toBeNull();
    expect(f.runtimes.get(f.binding.runtime_id)!.event_cursor).toBe(
      JSON.parse(readFileSync(join(f.directory, 'huddle-owner.json'), 'utf8')).observation,
    );
    expect(f.reconciler.autoResumeIds()).not.toContain(f.session.id);
  } finally {
    await f.close();
  }
});

it('retains the committed cursor when projection fails and rejects forged or incomplete observations', async () => {
  const f = await fixture();
  try {
    const id = f.binding.runtime_id;
    const before = f.runtimes.get(id)!;
    f.db.exec(
      "CREATE TRIGGER fail_huddle_projection BEFORE UPDATE ON runtime_bindings WHEN NEW.role = 'huddle' BEGIN SELECT RAISE(ABORT, 'unavailable storage'); END",
    );
    await f.client.request({
      t: 'arm',
      expectedGeneration: f.client.state!.control.generation,
      autoStart: false,
    });
    await until(() => f.reconciler.pendingIds().includes(id));
    expect(f.runtimes.get(id)).toEqual(before);
    expect(f.sessions.get(f.session.id).status).toBe('exited');
    f.db.exec('DROP TRIGGER fail_huddle_projection');
    await f.reconciler.refresh(id);
    await until(() => f.reconciler.settled(id));
    expect(f.sessions.get(f.session.id).status).toBe('running');
    const state = f.client.state!;
    const applied = vi.fn();
    for (const invalid of [
      { ...state, persistencePending: true },
      { ...state, observation: 0 },
      { ...state, scope: { ...state.scope, sessionId: randomUUID() } },
      { ...state, identity: { ...state.identity, incarnation: randomUUID() } },
    ])
      expect(() => f.runtimes.observeHuddle(id, invalid, applied)).toThrow();
    expect(applied).not.toHaveBeenCalled();
    const current = f.runtimes.get(id)!;
    expect(() =>
      f.runtimes.observeHuddle(id, { ...state, observation: state.observation + 1 }, () => {
        throw new Error('projection failed');
      }),
    ).toThrow('projection failed');
    expect(f.runtimes.get(id)).toEqual(current);
  } finally {
    await f.close();
  }
});

it('pauses projection writes, catches up on release and does not poll a settled idle owner', async () => {
  const f = await fixture();
  try {
    await f.run();
    await until(() => f.reconciler.settled(f.binding.runtime_id));
    const hold = f.reconciler.pause();
    await hold.drain();
    const before = f.runtimes.get(f.binding.runtime_id)!.event_cursor;
    writeFileSync(join(f.home, 'release'), 'go');
    await until(() => existsSync(join(f.home, 'completed')));
    await delay(100);
    expect(f.runtimes.get(f.binding.runtime_id)!.event_cursor).toBe(before);
    expect(f.reconciler.settled(f.binding.runtime_id)).toBe(false);
    hold.release();
    await until(
      () =>
        f.runtimes.get(f.binding.runtime_id)!.event_cursor > before &&
        f.reconciler.settled(f.binding.runtime_id),
    );
    const inspected = vi.spyOn(f.client, 'request');
    await delay(150);
    expect(inspected).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it('keeps a mismatched live owner protected and reconnects without replay after metadata is repaired', async () => {
  const f = await fixture();
  try {
    await f.run();
    const id = f.binding.runtime_id;
    f.db.prepare("UPDATE runtime_bindings SET build = 'wrong-build' WHERE runtime_id = ?").run(id);
    f.client.close();
    await f.connections.connectOwner(id);
    expect(f.connections.getHuddle(id)).toBeNull();
    expect(f.connections.unavailableIds()).toContain(id);
    expect(f.runtimes.ownerOf(f.session.id)?.runtime_id).toBe(id);
    expect(f.sessions.get(f.session.id).status).not.toBe('interrupted');
    f.db
      .prepare('UPDATE runtime_bindings SET build = ? WHERE runtime_id = ?')
      .run(f.launch.build, id);
    await f.attach();
    writeFileSync(join(f.home, 'release'), 'go');
    await until(() => existsSync(join(f.home, 'completed')));
    expect(readFileSync(join(f.home, 'entered'), 'utf8')).toBe('x');
  } finally {
    await f.close();
  }
});

it('records owner loss as interrupted, retaining unresolved worktree, release and memory ownership', async () => {
  const f = await fixture();
  try {
    const exited = once(f.owner.child, 'exit');
    f.owner.child.kill('SIGKILL');
    await exited;
    await f.connections.connect();
    await until(() => f.runtimes.get(f.binding.runtime_id)!.state === 'interrupted');
    expect(f.sessions.get(f.session.id).status).toBe('interrupted');
    expect(f.runtimes.hasUnreleasedWorktree(f.launch.identity.canonical_worktree_path)).toBe(true);
    expect(f.runtimes.releaseReferences()).toContainEqual({
      runtime_id: f.binding.runtime_id,
      release_path: f.directory,
    });
    expect(f.reconciler.autoResumeIds()).not.toContain(f.session.id);
    expect(existsSync(join(f.directory, 'retired.json'))).toBe(true);
    expect(
      new RuntimeServiceCleanupStore(f.db).pending().map((row) => row.runtime_id),
    ).not.toContain(f.binding.runtime_id);
    const memory = HostMemoryLedger.openExisting(f.home)!;
    try {
      expect(memory.readGrant(f.launch.identity)).not.toBeNull();
    } finally {
      memory.close();
    }
  } finally {
    await f.close();
  }
});

it('projects a surviving huddle through real isolated daemon replacement without replaying its script', async () => {
  const f = await fixture();
  let daemon: ReturnType<typeof launchOwner> | undefined;
  const stopDaemon = async () => {
    if (!daemon || daemon.child.exitCode !== null || daemon.child.signalCode !== null) return;
    const ended = once(daemon.child, 'exit');
    daemon.child.kill('SIGTERM');
    await ended;
  };
  try {
    await f.run();
    await until(() => f.reconciler.settled(f.binding.runtime_id));
    await f.disconnect();
    const before = f.runtimes.get(f.binding.runtime_id)!.event_cursor;
    for (let iteration = 0; iteration < 2; iteration++) {
      const ready = join(f.home, 'test-daemon-ready.json');
      rmSync(ready, { force: true });
      daemon = launchOwner(f.home, f.binding.runtime_id, 'daemon-owner.mjs');
      await until(() => {
        if (daemon!.child.exitCode !== null) throw new Error(daemon!.errors());
        return existsSync(ready);
      });
      if (iteration === 0) writeFileSync(join(f.home, 'release'), 'go');
      await until(() => f.runtimes.get(f.binding.runtime_id)!.event_cursor > before);
      expect(f.sessions.get(f.session.id).status).toBe('running');
      expect(f.runtimes.ownerOf(f.session.id)?.runtime_id).toBe(f.binding.runtime_id);
      expect(readFileSync(join(f.home, 'entered'), 'utf8')).toBe('x');
      await stopDaemon();
      expect(f.owner.child.exitCode).toBeNull();
      expect(f.owner.child.signalCode).toBeNull();
    }
  } finally {
    await stopDaemon();
    await f.close();
  }
});

it('archives a running huddle through the ordinary daemon route only after clean owner shutdown', async () => {
  const f = await fixture();
  let daemon: ReturnType<typeof launchOwner> | undefined;
  try {
    await f.run();
    await f.disconnect();
    const readyFile = join(f.home, 'test-daemon-ready.json');
    daemon = launchOwner(f.home, f.binding.runtime_id, 'daemon-owner.mjs');
    await until(() => {
      if (daemon!.child.exitCode !== null) throw new Error(daemon!.errors());
      return existsSync(readyFile);
    });
    const ready = JSON.parse(readFileSync(readyFile, 'utf8')) as { port: number; token: string };
    const response = await fetch(
      `http://127.0.0.1:${ready.port}/api/sessions/${f.session.id}/archive`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${ready.token}`, 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(20_000),
      },
    );
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(f.runtimes.get(f.binding.runtime_id)?.state).toBe('exited');
    expect(f.sessions.get(f.session.id).status).toBe('archived');
    expect(readFileSync(join(f.home, 'entered'), 'utf8')).toBe('x');
    expect(existsSync(f.home)).toBe(true);
  } finally {
    if (daemon && daemon.child.exitCode === null && daemon.child.signalCode === null) {
      const ended = once(daemon.child, 'exit');
      daemon.child.kill('SIGTERM');
      await ended;
    }
    await f.close();
  }
});
