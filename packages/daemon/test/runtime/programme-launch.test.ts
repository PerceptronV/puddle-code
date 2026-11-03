import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { puddlangRunSchema, runtimeStateSchema } from '@puddle/shared';
import { AccountStore } from '../../src/db/stores/accounts.js';
import { PuddlangStore } from '../../src/puddlang/store.js';
import { readRuntimeJson, runtimeDirectory } from '../../src/runtime/storage.js';
import { runtimeDatabase } from '../helpers/runtime-database.js';
import { launchOwner } from '../helpers/runtime-fixture.js';
import { sh } from '../helpers/git-fixtures.js';
import { waitFor } from '../helpers/daemon-fixtures.js';

it.each(['interactive', 'headless'] as const)(
  'retains an accepted %s programme turn across daemon replacement without replaying its programme',
  async (mode) => {
    const f = runtimeDatabase(mode);
    const programmes = new PuddlangStore(f.db);
    let daemon: ReturnType<typeof launchOwner> | undefined;
    let ready: { port: number; token: string } | undefined;
    const request = (path: string, body?: object) =>
      fetch(`http://127.0.0.1:${ready!.port}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ready!.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(20_000),
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
    const submit = async (source: string) => {
      const response = await request(`/api/puddlang/${f.profile.id}/runs`, {
        id: randomUUID(),
        source,
      });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(202);
      return puddlangRunSchema.parse(body);
    };
    try {
      f.runtimes.finish(f.binding.runtime_id, 'exited', () =>
        f.sessions.setStatus(f.session.id, 'exited'),
      );
      new AccountStore(f.db).setLoggedIn(f.account!.id, true);
      sh(f.home, 'init', '-b', 'main');
      writeFileSync(join(f.home, 'test-enable-runtime-launcher'), '');
      writeFileSync(join(f.home, 'test-slow-turn'), '');
      f.controller.release();
      await start();
      const run = await submit(`import { spawn } from 'puddlang';
      const agent = await spawn(${JSON.stringify({ agent: 'runtime-test', project: f.project.id, mode })});
      export default await agent.ask('survive daemon replacement');`);
      let mapping: { runtime_id: string; session_id: string; turn: number } | undefined;
      await waitFor(() => {
        const status = programmes.get(f.profile.id, run.id);
        if (status.status !== 'running') throw new Error(JSON.stringify(status));
        mapping = f.db
          .prepare(
            'SELECT runtime_id, session_id, turn FROM puddlang_runtime_turns WHERE run_id = ?',
          )
          .get(run.id) as typeof mapping;
        if (!mapping) return false;
        try {
          return (
            (readRuntimeJson(join(f.home, `${mapping.session_id}.turns.json`)) as { count: number })
              .count === 1
          );
        } catch {
          return false;
        }
      });
      const owner = f.runtimes.get(mapping!.runtime_id)!;
      expect(f.sessions.get(mapping!.session_id).agent_mode).toBe(mode);
      const directory = runtimeDirectory(f.home, owner.runtime_id);
      const state = () => runtimeStateSchema.parse(readRuntimeJson(join(directory, 'state.json')));
      const pid = state().terminals[0]!.pid;
      await stop();
      expect(programmes.get(f.profile.id, run.id).status).toBe('interrupted');
      await waitFor(() => state().turn?.status === 'completed');
      expect(state().terminals[0]!.pid).toBe(pid);
      await start();
      expect(f.reconciler.observations.turn(owner.runtime_id, mapping!.turn)).toMatchObject({
        status: 'completed',
        reply: 'reply:1:survive daemon replacement',
      });
      expect(programmes.get(f.profile.id, run.id).status).toBe('interrupted');
      expect(
        (readRuntimeJson(join(f.home, `${mapping!.session_id}.turns.json`)) as { count: number })
          .count,
      ).toBe(1);
      // User cancellation cancels this exact turn but leaves an attached agent alive.
      const cancelled = await submit(
        `import { attach } from 'puddlang'; const a = await attach('${owner.runtime_id}'); export default await a.ask('cancel this turn');`,
      );
      await waitFor(
        () =>
          (readRuntimeJson(join(f.home, `${mapping!.session_id}.turns.json`)) as { count: number })
            .count === 2,
      );
      const cancellation = await request(
        `/api/puddlang/${f.profile.id}/runs/${cancelled.id}/cancel`,
      );
      expect(cancellation.status).toBe(200);
      await cancellation.arrayBuffer();
      await waitFor(
        () => f.reconciler.observations.turn(owner.runtime_id, 2)?.status === 'cancelled',
      );
      expect(f.runtimes.get(owner.runtime_id)?.state).toBe('running');
      rmSync(join(f.home, 'test-slow-turn'));
      const next = await submit(
        `import { attach } from 'puddlang'; const a = await attach('${owner.runtime_id}'); const reply = await a.ask('next'); await a.stop(); export default reply;`,
      );
      await waitFor(() => programmes.get(f.profile.id, next.id).status !== 'running');
      expect(programmes.get(f.profile.id, next.id)).toMatchObject({
        status: 'completed',
        result: 'reply:3:next',
      });
      expect(f.runtimes.get(owner.runtime_id)?.state).toBe('exited');
      await stop();
    } finally {
      for (const owner of f.runtimes.live()) {
        try {
          const { pid } = readRuntimeJson(
            join(runtimeDirectory(f.home, owner.runtime_id), 'test-supervisor-pid.json'),
          ) as { pid: number };
          process.kill(pid, 'SIGTERM');
        } catch {
          /* Only this test's independently launched children. */
        }
      }
      if (daemon && daemon.child.exitCode === null && daemon.child.signalCode === null)
        await stop();
      await f.reconciler.close();
      f.db.close();
    }
  },
);
