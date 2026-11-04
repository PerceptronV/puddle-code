import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AccountStore } from '../../src/db/stores/accounts.js';
import { PuddlangStore } from '../../src/puddlang/store.js';
import { readRuntimeJson, runtimeDirectory } from '../../src/runtime/storage.js';
import { runtimeDatabase } from '../helpers/runtime-database.js';
import { launchOwner } from '../helpers/runtime-fixture.js';
import { sh } from '../helpers/git-fixtures.js';
import { waitFor } from '../helpers/daemon-fixtures.js';

it('cancels an in-flight programme spawn and never stops a later runtime in the same placement', async () => {
  const f = runtimeDatabase('headless');
  const runs = new PuddlangStore(f.db);
  let daemon: ReturnType<typeof launchOwner> | undefined;
  let ready: { port: number; token: string } | undefined;
  const request = (path: string, body?: object) =>
    fetch(`http://127.0.0.1:${ready!.port}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ready!.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(25_000),
    });
  const start = async () => {
    rmSync(join(f.home, 'test-daemon-ready.json'), { force: true });
    daemon = launchOwner(f.home, f.binding.runtime_id, 'daemon-owner.mjs');
    await waitFor(() => {
      if (daemon!.child.exitCode !== null) throw new Error(daemon!.errors());
      try {
        ready = readRuntimeJson(join(f.home, 'test-daemon-ready.json')) as typeof ready;
        return true;
      } catch {
        return false;
      }
    });
  };
  const stop = async () => {
    const ended = once(daemon!.child, 'exit');
    daemon!.child.kill('SIGTERM');
    expect((await ended)[0]).toBe(0);
  };
  try {
    f.runtimes.finish(f.binding.runtime_id, 'exited', () =>
      f.sessions.setStatus(f.session.id, 'exited'),
    );
    new AccountStore(f.db).setLoggedIn(f.account!.id, true);
    sh(f.home, 'init', '-b', 'main');
    writeFileSync(join(f.home, 'test-enable-runtime-launcher'), '');
    writeFileSync(join(f.home, 'test-hold-runtime-dispatch'), '');
    f.controller.release();
    await start();
    const id = randomUUID();
    const submitted = await request(`/api/puddlang/${f.profile.id}/runs`, {
      id,
      source: `import {spawn} from 'puddlang'; const a=await spawn(${JSON.stringify({ agent: 'runtime-test', project: f.project.id, mode: 'headless' })}); export default await a.ask('not dispatched');`,
    });
    expect(submitted.status).toBe(202);
    await submitted.arrayBuffer();
    await waitFor(() => existsSync(join(f.home, 'test-runtime-dispatch-pending.json')));
    const pending = readRuntimeJson(join(f.home, 'test-runtime-dispatch-pending.json')) as {
      runtime_id: string;
    };
    const owned = runs.spawns.list(f.profile.id, id)[0]!;
    expect(owned.runtime_id).toBe(pending.runtime_id); // Durable before the supervisor launches anything.
    expect(f.runtimes.get(pending.runtime_id)?.state).toBe('prepared');
    const cancelling = request(`/api/puddlang/${f.profile.id}/runs/${id}/cancel`);
    await waitFor(() => runs.spawns.list(f.profile.id, id)[0]?.stop_requested === 1);
    rmSync(join(f.home, 'test-hold-runtime-dispatch'));
    const cancelled = await cancelling;
    expect(cancelled.status).toBe(200);
    await cancelled.arrayBuffer();
    expect(runs.get(f.profile.id, id).status).toBe('cancelled');
    expect(f.runtimes.get(pending.runtime_id)?.state).toBe('exited');
    expect(existsSync(join(f.home, `${owned.session_id}.turns.json`))).toBe(false);
    expect(runs.events(f.profile.id, id, 0).events).toContainEqual(
      expect.objectContaining({ type: 'runtime_cleanup', data: { unconfirmed: [] } }),
    );
    const resumed = await request(`/api/sessions/${owned.session_id}/resume`);
    expect(resumed.status).toBe(200);
    await resumed.arrayBuffer();
    const replacement = f.runtimes.selectedOwner(owned.session_id)!;
    expect(replacement.runtime_id).not.toBe(pending.runtime_id);
    await stop();
    await start();
    expect(runs.spawns.list(f.profile.id, id)[0]?.runtime_id).toBe(pending.runtime_id);
    const retried = await request(`/api/puddlang/${f.profile.id}/runs/${id}/cancel`);
    expect(retried.status).toBe(200);
    await retried.arrayBuffer();
    expect(f.runtimes.get(replacement.runtime_id)?.state).toBe('running');
    expect(f.runtimes.live()).toHaveLength(1);
    const killed = await request(`/api/sessions/${owned.session_id}/kill`);
    expect(killed.status).toBe(200);
    await killed.arrayBuffer();
    await stop();
  } finally {
    rmSync(join(f.home, 'test-hold-runtime-dispatch'), { force: true });
    for (const owner of f.runtimes.live()) {
      try {
        const { pid } = readRuntimeJson(
          join(runtimeDirectory(f.home, owner.runtime_id), 'test-supervisor-pid.json'),
        ) as { pid: number };
        process.kill(pid, 'SIGTERM');
      } catch {
        /* Only the isolated fake supervisor's children. */
      }
    }
    if (daemon && daemon.child.exitCode === null && daemon.child.signalCode === null) await stop();
    await f.reconciler.close();
    f.db.close();
  }
});
