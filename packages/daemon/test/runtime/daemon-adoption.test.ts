import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RuntimeClient } from '../../src/runtime/transport/client.js';
import { RuntimeObservationStore } from '../../src/db/stores/runtime-observations.js';
import { acquireRuntimeController, readRuntimeJson } from '../../src/runtime/ownership/storage.js';
import { readRuntimeJournal } from '../../src/runtime/state/journal.js';
import { runtimeDatabase } from '../helpers/runtime-database.js';
import {
  clients,
  controllers,
  launchOwner,
  terminal,
  waitForOwner,
  waitForSnapshot,
} from '../helpers/runtime-fixture.js';
import { placement } from '../helpers/runtime-placement.js';

async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it('reconciles offline native switches and a completed turn through real daemon restarts without recreating processes', async () => {
  const f = runtimeDatabase('headless');
  try {
    const { home, launch, directory, controller } = f;
    const runtime = launchOwner(home, launch.identity.runtime_id, 'provider-owner.mjs');
    await waitForOwner(runtime, directory);
    const original = await RuntimeClient.open(home, launch, controller.record);
    clients.push(original);
    const main = terminal(original.state);
    const sidecars = original.state!.agent!.sidecar_pids;
    const initialAddress = placement(original);
    const hook = readRuntimeJson(join(home, `${f.session.id}.signals.json`)) as {
      url: string;
      nonce: string;
    };
    const signal = async (ref: string, source: 'startup' | 'clear' | 'fork') => {
      const response = await fetch(hook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nonce: hook.nonce,
          event: 'session_start',
          agent_session_ref: ref,
          cwd: home,
          source,
        }),
        signal: AbortSignal.timeout(5000),
      });
      await response.arrayBuffer();
      expect(response.status).toBe(204);
    };
    await signal('first', 'startup');
    await original.request({
      t: 'input',
      placement: initialAddress,
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: "stty -echo; survivor=unchanged; printf 'adoption-%s\\n' ready\n",
    });
    await waitForSnapshot(original, main.generation, 'adoption-ready');
    await original.request({
      t: 'start-turn',
      placement: initialAddress,
      turn: 1,
      expected_ref: 'first',
      prompt: 'retain this private result',
    });
    original.close();
    controller.release();
    await until(
      () =>
        readRuntimeJournal(directory, launch.identity).events.some(
          (event) => event.t === 'turn-finished',
        ),
      'Provider turn did not finish without its controller',
    );
    await signal('second', 'clear');
    await signal('third', 'fork');
    const outcomes = new RuntimeObservationStore(f.db);
    let committedCursor = -1;
    let currentSession = '';
    let auditCount = -1;
    for (let iteration = 0; iteration < 2; iteration++) {
      rmSync(join(home, 'test-daemon-ready.json'), { force: true });
      const daemon = launchOwner(home, launch.identity.runtime_id, 'daemon-owner.mjs');
      await until(() => {
        if (daemon.child.exitCode !== null) throw new Error(`Daemon exited: ${daemon.errors()}`);
        try {
          readRuntimeJson(join(home, 'test-daemon-ready.json'));
          return true;
        } catch {
          return false;
        }
      }, 'Daemon did not become ready');
      const binding = f.runtimes.get(f.binding.runtime_id)!;
      const session = f.sessions.get(binding.active_session_id);
      expect(session.agent_session_ref).toBe(iteration === 0 ? 'third' : 'fourth');
      expect(session.agent_mode).toBe('headless');
      expect(f.sessions.list()).toHaveLength(iteration === 0 ? 3 : 4);
      expect(f.sessions.get(f.session.id).status).toBe('exited');
      expect(f.sessions.getEnv(session.id)).toEqual({ INITIAL: 'seed' });
      expect(outcomes.turn(binding.runtime_id, 1)).toEqual({
        turn: 1,
        expected_ref: 'first',
        status: 'completed',
        reply: 'reply:1:retain this private result',
      });
      const audit = f.sessions.list().flatMap((placement) => f.events.list(placement.id));
      expect(JSON.stringify(audit)).not.toContain('retain this private result');
      expect(audit.filter((event) => event.type === 'native_switched_to')).toHaveLength(
        iteration === 0 ? 2 : 3,
      );
      expect(readRuntimeJournal(directory, launch.identity).acknowledged).toBe(
        binding.event_cursor,
      );
      expect(outcomes.get(binding.runtime_id)?.terminals[0]?.pid).toBe(main.pid);
      if (iteration > 0) {
        expect(binding.event_cursor).toBe(committedCursor);
        expect(session.id).toBe(currentSession);
        expect(audit.length).toBe(auditCount);
      }
      if (iteration === 0) {
        // Live observations use the same commit/bind/ack path as boot recovery.
        await signal('fourth', 'clear');
        await until(() => {
          const current = f.runtimes.get(binding.runtime_id)!;
          return (
            f.sessions.get(current.active_session_id).agent_session_ref === 'fourth' &&
            readRuntimeJournal(directory, launch.identity).acknowledged === current.event_cursor
          );
        }, 'Live native observation was not reconciled');
      }
      const committed = f.runtimes.get(binding.runtime_id)!;
      committedCursor = committed.event_cursor;
      currentSession = committed.active_session_id;
      auditCount = f.sessions.list().flatMap((placement) => f.events.list(placement.id)).length;
      const stopped = once(daemon.child, 'exit');
      daemon.child.kill('SIGTERM');
      expect((await stopped)[0]).toBe(0);
      expect(runtime.child.exitCode).toBeNull();
    }
    const replacement = acquireRuntimeController(home);
    controllers.push(replacement);
    const next = await RuntimeClient.open(home, launch, replacement.record);
    clients.push(next);
    expect(terminal(next.state).pid).toBe(main.pid);
    expect(next.state!.agent!.sidecar_pids).toEqual(sidecars);
    expect(next.state!.binding?.session_id).toBe(currentSession);
    await expect(
      next.request({
        t: 'input',
        placement: initialAddress,
        term: 'agent',
        generation: main.generation,
        source: 'human',
        data: 'survivor=wrong\n',
      }),
    ).rejects.toMatchObject({ code: 'stale_placement' });
    await next.request({
      t: 'input',
      placement: placement(next),
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: 'printf \'survivor-%s\\n\' "$survivor"\n',
    });
    await waitForSnapshot(next, main.generation, 'survivor-unchanged');
    expect(readRuntimeJson(join(home, `${f.session.id}.turns.json`))).toMatchObject({ count: 1 });
  } finally {
    await f.reconciler.close();
    f.db.close();
  }
});
