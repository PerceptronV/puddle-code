import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RUNTIME_PROTOCOL_VERSION } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { openDatabase } from '../../src/db/db.js';
import { ProfileStore } from '../../src/db/stores/profiles.js';
import { ProjectStore } from '../../src/db/stores/projects.js';
import { RepoStore } from '../../src/db/stores/repos.js';
import { SessionStore } from '../../src/db/stores/sessions.js';
import { RuntimeStore } from '../../src/db/stores/runtimes.js';
import { EventStore } from '../../src/db/stores/events.js';
import { RuntimeClient } from '../../src/runtime/client.js';
import { acquireRuntimeController, readRuntimeJson } from '../../src/runtime/storage.js';
import { readRuntimeJournal } from '../../src/runtime/journal.js';
import { ensureHome, resolvePaths } from '../../src/paths.js';
import {
  clients,
  controllers,
  launchOwner,
  prepare,
  terminal,
  waitForOwner,
  waitForSnapshot,
} from '../helpers/runtime-fixture.js';
import { placement } from '../helpers/runtime-placement.js';

it('protects external ownership across real daemon starts and stops, including an unauthenticated owner response', async () => {
  const { home, launch, directory, controller } = prepare();
  const paths = resolvePaths(home);
  ensureHome(paths);
  const db = openDatabase(paths.dbFile);
  try {
    const profile = new ProfileStore(db).create({ name: 'runtime-boot', branch_prefix: '' });
    const repo = new RepoStore(db).create({
      path: home,
      default_base_branch: 'main',
      onboarding_notes: null,
      fetch_enabled: false,
    });
    const project = new ProjectStore(db).create({
      profile_id: profile.id,
      repo_id: repo.id,
      name: 'runtime-boot',
    });
    const sessions = new SessionStore(db);
    const session = sessions.create({
      id: randomUUID(),
      project_id: project.id,
      account_id: null,
      worktree_path: home,
      base_branch: 'main',
      branch: 'main',
      separate_branch: false,
      kind: 'terminal',
      agent_type: null,
      title: null,
      skip_permissions: false,
      status: 'running',
    });
    Object.assign(launch.identity, {
      profile_id: profile.id,
      project_id: project.id,
      session_id: session.id,
      canonical_worktree_path: realpathSync(home),
    });
    atomicPrivateJson(join(directory, 'launch.json'), launch);
    const store = new RuntimeStore(db);
    const original = store.prepare({
      identity: launch.identity,
      build: 'runtime-test',
      protocol: RUNTIME_PROTOCOL_VERSION,
      releasePath: directory,
    });
    const runtime = launchOwner(home, launch.identity.runtime_id);
    await waitForOwner(runtime, directory);
    const first = await RuntimeClient.open(home, launch, controller.record);
    clients.push(first);
    const main = terminal(first.state);
    await first.request({
      t: 'input',
      placement: placement(first),
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: "stty -echo; continuity=kept; printf 'boot-%s\\n' ready\n",
    });
    await waitForSnapshot(first, main.generation, 'boot-ready');
    first.close();
    controller.release();

    for (const mode of ['authenticated', 'wrong-secret', 'wrong-build']) {
      const expectedBuild = mode === 'wrong-build' ? 'different-build' : original.build;
      db.prepare('UPDATE runtime_bindings SET build = ? WHERE runtime_id = ?').run(
        expectedBuild,
        original.runtime_id,
      );
      atomicPrivateJson(join(directory, 'launch.json'), {
        ...launch,
        secret: mode === 'wrong-secret' ? '0'.repeat(64) : launch.secret,
      });
      rmSync(join(home, 'test-daemon-ready.json'), { force: true });
      const daemon = launchOwner(home, launch.identity.runtime_id, 'daemon-owner.mjs');
      let output = '';
      daemon.child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      let ready: { port: number; token: string } | undefined;
      const deadline = Date.now() + 15_000;
      while (!ready) {
        try {
          ready = readRuntimeJson(join(home, 'test-daemon-ready.json')) as typeof ready;
        } catch {
          if (daemon.child.exitCode !== null || Date.now() > deadline)
            throw new Error(`Daemon did not become ready: ${daemon.errors()}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      const request = (route: string, method = 'GET') =>
        fetch(`http://127.0.0.1:${ready!.port}${route}`, {
          method,
          headers: { authorization: `Bearer ${ready!.token}` },
          signal: AbortSignal.timeout(5000),
        });
      const status = await request(`/api/sessions/${session.id}`);
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ status: 'running' });
      for (const action of ['kill', 'resume', 'archive']) {
        const result = await request(`/api/sessions/${session.id}/${action}`, 'POST');
        expect(result.status).toBe(409);
        expect(await result.json()).toMatchObject({
          error: { code: 'runtime_reconciliation_required' },
        });
      }
      expect(sessions.get(session.id).status).toBe('running');
      expect(store.get(original.runtime_id)).toEqual({ ...original, build: expectedBuild });
      expect(new EventStore(db).list(session.id)).toEqual([]);
      expect(readRuntimeJournal(directory, launch.identity).acknowledged).toBe(0);
      const stopped = once(daemon.child, 'exit');
      daemon.child.kill('SIGTERM');
      expect((await stopped)[0]).toBe(0);
      expect(output).toContain(`${mode === 'authenticated' ? 0 : 1} owner(s) unavailable`);
      expect(runtime.child.exitCode).toBeNull();
      expect(() => process.kill(main.pid!, 0)).not.toThrow();
    }
    db.prepare('UPDATE runtime_bindings SET build = ? WHERE runtime_id = ?').run(
      original.build,
      original.runtime_id,
    );
    atomicPrivateJson(join(directory, 'launch.json'), launch);
    const replacement = acquireRuntimeController(home);
    controllers.push(replacement);
    const next = await RuntimeClient.open(home, launch, replacement.record);
    clients.push(next);
    expect(terminal(next.state).pid).toBe(main.pid);
    await next.request({
      t: 'input',
      placement: placement(next),
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: 'printf \'continuity-%s\\n\' "$continuity"\n',
    });
    await waitForSnapshot(next, main.generation, 'continuity-kept');
    expect(store.live()).toEqual([original]);
  } finally {
    db.close();
  }
});
