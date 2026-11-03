import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { RuntimeRetainedEvent } from '@puddle/shared';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { RuntimeClient } from '../../src/runtime/client.js';
import { RuntimeConnections } from '../../src/runtime/connections.js';
import { readRuntimeJournal } from '../../src/runtime/journal.js';
import { readRuntimeJson } from '../../src/runtime/storage.js';
import { runtimeDatabase } from '../helpers/runtime-database.js';
import {
  clients,
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

it('reconnects a lost control stream without replaying work, then retires the owner after natural exit', async () => {
  const f = runtimeDatabase();
  let connections: RuntimeConnections | undefined;
  try {
    const owner = launchOwner(f.home, f.binding.runtime_id);
    await waitForOwner(owner, f.directory);
    f.controller.release();
    connections = new RuntimeConnections(f.home, f.runtimes, {
      connected: (id, client) => f.reconciler.attach(id, client),
      missing: (id) => f.reconciler.retire(id),
    });
    await connections.connect();
    const first = connections.get(f.binding.runtime_id)!;
    const main = terminal(first.state);
    await first.request({
      t: 'input',
      placement: placement(first),
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: "stty -echo; survived=once; printf 'recovery-%s\\n' ready\n",
    });
    await waitForSnapshot(first, main.generation, 'recovery-ready');
    expect(await f.reconciler.retire(f.binding.runtime_id)).toBe(false);
    first.close();
    await until(
      () => !!connections!.get(f.binding.runtime_id),
      'Control connection was not recovered',
    );
    const next = connections.get(f.binding.runtime_id)!;
    await f.reconciler.refresh(f.binding.runtime_id);
    expect(next).not.toBe(first);
    expect(terminal(next.state).pid).toBe(main.pid);
    expect(f.reconciler.pendingIds()).toEqual([]);
    expect(f.events.list(f.session.id)).toEqual([]);
    await next.request({
      t: 'input',
      placement: placement(next),
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: 'printf \'survived-%s\\n\' "$survived"\n',
    });
    await waitForSnapshot(next, main.generation, 'survived-once');
    const exited = once(owner.child, 'exit');
    await next.request({
      t: 'input',
      placement: placement(next),
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: 'exit 7\n',
    });
    await exited;
    await until(
      () => f.runtimes.get(f.binding.runtime_id)?.state === 'exited',
      'Final owner observations were not retired',
    );
    expect(f.sessions.get(f.session.id).status).toBe('exited');
    expect(f.runtimes.ownerOf(f.session.id)).toBeNull();
    expect(f.reconciler.autoResumeIds()).toEqual([]);
    expect(f.events.list(f.session.id).map((event) => event.type)).toEqual(['exited']);
    expect(f.reconciler.observations.get(f.binding.runtime_id)?.terminals[0]).toMatchObject({
      pid: null,
      exit_code: 7,
    });
    expect(readRuntimeJson(join(f.directory, 'retired.json'))).toMatchObject({
      identity: f.launch.identity,
    });
  } finally {
    await f.reconciler.close();
    await connections?.close();
    f.db.close();
  }
});

it('atomically imports an offline exit and retries a failed final commit without duplicate events', async () => {
  const f = runtimeDatabase();
  try {
    const owner = launchOwner(f.home, f.binding.runtime_id);
    await waitForOwner(owner, f.directory);
    const client = await RuntimeClient.open(f.home, f.launch, f.controller.record);
    clients.push(client);
    const exited = once(owner.child, 'exit');
    await client.request({ t: 'stop', placement: placement(client) });
    await exited;
    f.db.exec(
      "CREATE TRIGGER fail_final BEFORE UPDATE OF state ON runtime_bindings WHEN NEW.state = 'exited' BEGIN SELECT RAISE(ABORT, 'final commit failed'); END",
    );
    await expect(f.reconciler.retire(f.binding.runtime_id)).rejects.toThrow('final commit failed');
    expect(f.runtimes.get(f.binding.runtime_id)).toEqual(f.binding);
    expect(f.events.list(f.session.id)).toEqual([]);
    expect(f.reconciler.observations.get(f.binding.runtime_id)).toBeNull();
    expect(readRuntimeJson(join(f.directory, 'retired.json'))).toMatchObject({
      identity: f.launch.identity,
    });
    f.db.exec('DROP TRIGGER fail_final');
    expect(await f.reconciler.retire(f.binding.runtime_id)).toBe(true);
    expect(f.runtimes.get(f.binding.runtime_id)?.state).toBe('exited');
    expect(f.events.list(f.session.id).map((event) => event.type)).toEqual(['exited']);
    const late = launchOwner(f.home, f.binding.runtime_id);
    expect((await once(late.child, 'exit'))[0]).not.toBe(0);
    expect(late.errors()).toContain('Runtime launch was retired');
  } finally {
    await f.reconciler.close();
    f.db.close();
  }
});

it('marks a confirmed abrupt owner loss interrupted without treating stale state as a completed exit', async () => {
  const f = runtimeDatabase();
  try {
    const owner = launchOwner(f.home, f.binding.runtime_id);
    await waitForOwner(owner, f.directory);
    const client = await RuntimeClient.open(f.home, f.launch, f.controller.record);
    clients.push(client);
    await f.reconciler.attach(f.binding.runtime_id, client);
    const exited = once(owner.child, 'exit');
    owner.child.kill('SIGKILL');
    await exited;
    expect(await f.reconciler.retire(f.binding.runtime_id)).toBe(true);
    expect(f.runtimes.get(f.binding.runtime_id)?.state).toBe('interrupted');
    expect(f.sessions.get(f.session.id).status).toBe('interrupted');
    expect(f.events.list(f.session.id).map((event) => event.type)).toEqual(['interrupted']);
    expect(f.reconciler.autoResumeIds()).toEqual([f.session.id]);
  } finally {
    await f.reconciler.close();
    f.db.close();
  }
});

it('fences an unstarted launch and preserves unresolved ownership when retained history has a gap', async () => {
  const f = runtimeDatabase();
  try {
    expect(await f.reconciler.retire(f.binding.runtime_id)).toBe(true);
    expect(f.runtimes.get(f.binding.runtime_id)?.state).toBe('interrupted');
    const late = launchOwner(f.home, f.binding.runtime_id);
    expect((await once(late.child, 'exit'))[0]).not.toBe(0);
    expect(late.errors()).toContain('Runtime launch was retired');
  } finally {
    await f.reconciler.close();
    f.db.close();
  }
  const g = runtimeDatabase();
  try {
    const owner = launchOwner(g.home, g.binding.runtime_id);
    await waitForOwner(owner, g.directory);
    const client = await RuntimeClient.open(g.home, g.launch, g.controller.record);
    clients.push(client);
    const exited = once(owner.child, 'exit');
    await client.request({ t: 'stop', placement: placement(client) });
    await exited;
    const journal = readRuntimeJournal(g.directory, g.launch.identity);
    atomicPrivateJson(join(g.directory, 'events.json'), {
      ...journal,
      lost_through: journal.cursor,
    });
    await expect(g.reconciler.retire(g.binding.runtime_id)).rejects.toThrow(/incomplete/);
    expect(g.runtimes.get(g.binding.runtime_id)).toEqual(g.binding);
    expect(g.reconciler.autoResumeIds()).toEqual([]);
  } finally {
    await g.reconciler.close();
    g.db.close();
  }
});

it('retains an interrupted turn outcome after confirmed loss without exposing it in audit events', async () => {
  const f = runtimeDatabase('headless');
  try {
    atomicPrivateJson(join(f.directory, 'events.json'), {
      format: 1,
      identity: f.launch.identity,
      cursor: 1,
      acknowledged: 0,
      lost_through: 0,
      events: [
        { t: 'turn-started', cursor: 1, turn: { turn: 1, expected_ref: null, status: 'running' } },
      ],
    });
    expect(await f.reconciler.retire(f.binding.runtime_id)).toBe(true);
    expect(f.reconciler.observations.turn(f.binding.runtime_id, 1)).toMatchObject({
      turn: 1,
      status: 'interrupted',
      expected_ref: null,
      error: expect.stringContaining('execution was not replayed'),
    });
    expect(JSON.stringify(f.events.list(f.session.id))).not.toContain('turn');
    expect(f.reconciler.autoResumeIds()).toEqual([]);
    expect(f.runtimes.get(f.binding.runtime_id)).toMatchObject({
      state: 'interrupted',
      event_cursor: 1,
    });
  } finally {
    await f.reconciler.close();
    f.db.close();
  }
});

it.each([
  { ended: true, autoResume: true, status: 'exited' },
  { ended: false, autoResume: false, status: 'interrupted' },
  { ended: false, autoResume: true, status: 'running' },
])(
  'real daemon boot honours final exit and auto-resume policy: %j',
  async ({ ended, autoResume, status }) => {
    const f = runtimeDatabase();
    try {
      atomicPrivateJson(f.paths.configFile, { configVersion: 3, autoResume });
      const owner = launchOwner(f.home, f.binding.runtime_id);
      await waitForOwner(owner, f.directory);
      const client = await RuntimeClient.open(f.home, f.launch, f.controller.record);
      clients.push(client);
      const exited = once(owner.child, 'exit');
      if (ended) await client.request({ t: 'stop', placement: placement(client) });
      else owner.child.kill('SIGKILL');
      await exited;
      f.controller.release();
      const daemon = launchOwner(f.home, f.binding.runtime_id, 'daemon-owner.mjs');
      await until(() => {
        if (daemon.child.exitCode !== null) throw new Error(daemon.errors());
        try {
          readRuntimeJson(join(f.home, 'test-daemon-ready.json'));
          return true;
        } catch {
          return false;
        }
      }, 'Daemon did not recover the final runtime record');
      expect(f.runtimes.get(f.binding.runtime_id)?.state).toBe(ended ? 'exited' : 'interrupted');
      expect(f.sessions.get(f.session.id).status).toBe(status);
      expect(f.events.list(f.session.id).filter((event) => event.type === 'resumed')).toHaveLength(
        !ended && autoResume ? 1 : 0,
      );
      const stopped = once(daemon.child, 'exit');
      daemon.child.kill('SIGTERM');
      await stopped;
    } finally {
      await f.reconciler.close();
      f.db.close();
    }
  },
);

it('rolls back every recovered page and notification when a later final page fails', async () => {
  const f = runtimeDatabase('interactive');
  try {
    const events: RuntimeRetainedEvent[] = [
      {
        t: 'native-lifecycle',
        cursor: 1,
        segment: { id: f.binding.runtime_id, start_cursor: 0, agent_session_ref: 'first' },
        previous_segment_id: null,
        lifecycle: {
          event: 'session_start',
          agent_session_ref: 'first',
          cwd: f.home,
          source: 'startup',
        },
      },
    ];
    for (let cursor = 2; cursor <= 256; cursor++)
      events.push({ t: 'capture-env', cursor, enabled: cursor % 2 === 0 });
    events.push({
      t: 'native-lifecycle',
      cursor: 257,
      segment: { id: randomUUID(), start_cursor: 257, agent_session_ref: 'second' },
      previous_segment_id: f.binding.runtime_id,
      lifecycle: {
        event: 'session_start',
        agent_session_ref: 'second',
        cwd: f.home,
        source: 'clear',
      },
    });
    atomicPrivateJson(join(f.directory, 'events.json'), {
      format: 1,
      identity: f.launch.identity,
      cursor: 257,
      acknowledged: 0,
      lost_through: 0,
      events,
    });
    const changed = vi.fn();
    const switched = vi.fn();
    f.reconciler.on('changed', changed).on('session-switched', switched);
    f.db.exec(
      "CREATE TRIGGER fail_final_page BEFORE INSERT ON events WHEN NEW.type = 'native_switched_to' BEGIN SELECT RAISE(ABORT, 'final page failed'); END",
    );
    await expect(f.reconciler.retire(f.binding.runtime_id)).rejects.toThrow('final page failed');
    expect(f.runtimes.get(f.binding.runtime_id)).toEqual(f.binding);
    expect(f.sessions.list()).toHaveLength(1);
    expect(f.conversations.list()).toEqual([]);
    expect(f.reconciler.observations.get(f.binding.runtime_id)).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    expect(switched).not.toHaveBeenCalled();
    f.db.exec('DROP TRIGGER fail_final_page');
    expect(await f.reconciler.retire(f.binding.runtime_id)).toBe(true);
    expect(f.runtimes.get(f.binding.runtime_id)).toMatchObject({
      state: 'interrupted',
      event_cursor: 257,
    });
    expect(f.sessions.list()).toHaveLength(2);
    expect(switched).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
  } finally {
    await f.reconciler.close();
    f.db.close();
  }
});

it('collects a failed provider launch that never created an agent or PTY', async () => {
  const f = runtimeDatabase('headless');
  try {
    // The ordinary owner intentionally has no runtime-test adapter installed.
    const owner = launchOwner(f.home, f.binding.runtime_id);
    expect((await once(owner.child, 'exit'))[0]).not.toBe(0);
    expect(owner.errors()).toContain('no adapter');
    expect(await f.reconciler.retire(f.binding.runtime_id)).toBe(true);
    expect(f.runtimes.get(f.binding.runtime_id)?.state).toBe('failed');
    expect(f.sessions.get(f.session.id).status).toBe('exited');
    expect(f.reconciler.autoResumeIds()).toEqual([]);
    expect(f.events.list(f.session.id).map((event) => event.type)).toEqual(['runtime_failed']);
  } finally {
    await f.reconciler.close();
    f.db.close();
  }
});
