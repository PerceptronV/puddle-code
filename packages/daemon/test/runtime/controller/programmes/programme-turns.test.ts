import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { puddlangStartSchema } from '@puddle/shared';
import { PuddlangStore } from '../../../../src/puddlang/store.js';
import { ProgrammeTurnStore } from '../../../../src/puddlang/runtime-turn-store.js';
import { RuntimeProgrammeTurns } from '../../../../src/runtime/controller/programme-turns.js';
import { RuntimeConnections } from '../../../../src/runtime/transport/connections.js';
import {
  RuntimeConnectionLost,
  RuntimeRequestRejected,
} from '../../../../src/runtime/transport/client.js';
import { readRuntimeJson } from '../../../../src/runtime/ownership/storage.js';
import { runtimeDatabase } from '../../../helpers/runtime-database.js';
import { launchOwner, waitForOwner } from '../../../helpers/runtime-fixture.js';

async function fixture() {
  const f = runtimeDatabase('interactive');
  const owner = launchOwner(f.home, f.binding.runtime_id, 'provider-owner.mjs');
  await waitForOwner(owner, f.directory);
  f.controller.release();
  const connections = new RuntimeConnections(f.home, f.runtimes, {
    connected: (id, client) => f.reconciler.attach(id, client),
    missing: (id) => f.reconciler.retire(id),
  });
  await connections.connect();
  const runs = new PuddlangStore(f.db);
  const input = puddlangStartSchema.parse({ id: randomUUID(), source: 'export default null;' });
  runs.create(f.profile.id, input);
  const scope = { runId: input.id, operationId: 1, profileId: f.profile.id };
  const operations = new ProgrammeTurnStore(f.db);
  const turns = new RuntimeProgrammeTurns(f.runtimes, connections, f.reconciler, operations);
  const client = connections.get(f.binding.runtime_id)!;
  return {
    ...f,
    client,
    connections,
    runs,
    scope,
    turns,
    operations,
    async close() {
      await f.reconciler.close();
      await connections.close();
      f.db.close();
    },
  };
}

it('records turn identity before dispatch, recovers a lost acknowledgement and refuses duplicate operation delivery', async () => {
  const f = await fixture();
  try {
    const request = f.client.request.bind(f.client);
    let dispatched = 0;
    vi.spyOn(f.client, 'request').mockImplementation(async (value) => {
      if (value.t !== 'start-turn') return request(value);
      dispatched++;
      expect(
        f.db
          .prepare('SELECT runtime_id, turn FROM puddlang_runtime_turns WHERE run_id = ?')
          .get(f.scope.runId),
      ).toEqual({ runtime_id: f.binding.runtime_id, turn: value.turn });
      await request(value); // Accepted by the real owner; discard the reply.
      f.client.close();
      throw new RuntimeConnectionLost();
    });
    await expect(
      f.turns.ask(f.binding.runtime_id, f.scope, 'once only', new AbortController().signal),
    ).resolves.toBe('reply:1:once only');
    expect(dispatched).toBe(1);
    expect(f.db.prepare('SELECT consumed FROM runtime_turns').get()).toEqual({ consumed: 1 });
    await expect(
      f.turns.ask(f.binding.runtime_id, f.scope, 'once only', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'operation_already_dispatched' });
    expect(readRuntimeJson(join(f.home, `${f.session.id}.turns.json`))).toMatchObject({ count: 1 });
  } finally {
    await f.close();
  }
});

it('releases repeated correlated pre-admission rejections without reusing operation identities', async () => {
  const f = await fixture();
  try {
    const request = f.client.request.bind(f.client);
    const changed = vi
      .spyOn(f.client, 'request')
      .mockImplementation((value) =>
        request(
          value.t === 'start-turn' ? { ...value, expected_ref: 'changed-before-admission' } : value,
        ),
      );
    for (let operationId = 1; operationId <= 20; operationId++) {
      await expect(
        f.turns.ask(
          f.binding.runtime_id,
          { ...f.scope, operationId },
          'refuse',
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(RuntimeRequestRejected);
      expect(f.db.prepare('SELECT turns, bytes FROM host_result_usage').get()).toEqual({
        turns: 0,
        bytes: 0,
      });
    }
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM puddlang_runtime_turns').get()).toEqual({
      n: 20,
    });
    expect(existsSync(join(f.home, `${f.session.id}.turns.json`))).toBe(false);
    changed.mockRestore();
    await expect(
      f.turns.ask(
        f.binding.runtime_id,
        { ...f.scope, operationId: 21 },
        'first accepted',
        new AbortController().signal,
      ),
    ).resolves.toBe('reply:1:first accepted');
  } finally {
    await f.close();
  }
});

it('releases a proven undispatched reservation even after its programme is cancelled', async () => {
  const f = await fixture();
  try {
    const reserve = f.operations.reserve.bind(f.operations);
    vi.spyOn(f.operations, 'reserve').mockImplementation((...args) => {
      const turn = reserve(...args);
      f.runs.finish(f.scope.runId, 'cancelled');
      return turn;
    });
    await expect(
      f.turns.ask(f.binding.runtime_id, f.scope, 'not sent', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'profile_scope' });
    expect(f.db.prepare('SELECT turns, bytes FROM host_result_usage').get()).toEqual({
      turns: 0,
      bytes: 0,
    });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM puddlang_runtime_turns').get()).toEqual({
      n: 1,
    });
    expect(existsSync(join(f.home, `${f.session.id}.turns.json`))).toBe(false);
  } finally {
    await f.close();
  }
});

it('rejects unsupported provider input before recording reservation or operation identity', async () => {
  const f = await fixture();
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      const schema =
        attempt % 2 ? { ['x'.repeat(257)]: 'oversized key' } : { value: 'x'.repeat(64 * 1024) };
      await expect(
        f.turns.ask(
          f.binding.runtime_id,
          f.scope,
          'invalid schema',
          new AbortController().signal,
          schema,
        ),
      ).rejects.toThrow();
    }
    expect(f.db.prepare('SELECT turns, bytes FROM host_result_usage').get()).toEqual({
      turns: 0,
      bytes: 0,
    });
    expect(f.db.prepare('SELECT * FROM puddlang_runtime_turns').all()).toEqual([]);
    await expect(
      f.turns.ask(f.binding.runtime_id, f.scope, 'valid', new AbortController().signal),
    ).resolves.toBe('reply:1:valid');
  } finally {
    await f.close();
  }
});

it.each(['generic', 'failed', 'duplicate_request'] as const)(
  'retains uncertain reservations after a %s error',
  async (kind) => {
    const f = await fixture();
    try {
      const request = f.client.request.bind(f.client);
      vi.spyOn(f.client, 'request').mockImplementation((value) =>
        value.t === 'start-turn'
          ? Promise.reject(
              kind === 'generic'
                ? Object.assign(new Error('unknown'), { code: 'busy' })
                : new RuntimeRequestRejected(kind, 'unknown', 'start-turn'),
            )
          : request(value),
      );
      await expect(
        f.turns.ask(f.binding.runtime_id, f.scope, 'uncertain', new AbortController().signal),
      ).rejects.toThrow('unknown');
      expect(f.db.prepare('SELECT turns FROM host_result_usage').get()).toEqual({ turns: 1 });
    } finally {
      await f.close();
    }
  },
);

it('rejects a full unread result store before dispatching another provider prompt', async () => {
  const f = await fixture();
  try {
    const binding = f.runtimes.get(f.binding.runtime_id)!;
    for (let turn = 1; turn <= 128; turn++) {
      f.reconciler.observations.saveTurn(binding, { turn, expected_ref: null, status: 'running' });
      f.reconciler.observations.saveTurn(binding, {
        turn,
        expected_ref: null,
        status: 'completed',
        reply: `unread-${turn}`,
      });
    }
    await expect(
      f.turns.ask(f.binding.runtime_id, f.scope, 'no capacity', new AbortController().signal),
    ).rejects.toThrow('retention is full');
    expect(f.db.prepare('SELECT * FROM puddlang_runtime_turns').all()).toEqual([]);
    expect(existsSync(join(f.home, `${f.session.id}.turns.json`))).toBe(false);
  } finally {
    await f.close();
  }
});

it('releases dispatch admission while the independent owner is still answering', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.home, 'test-slow-turn'), '');
    const dispatched = vi.fn();
    let settled = false;
    const answer = f.turns
      .ask(
        f.binding.runtime_id,
        f.scope,
        'keep working',
        new AbortController().signal,
        undefined,
        undefined,
        dispatched,
      )
      .finally(() => {
        settled = true;
      });
    await expect.poll(() => dispatched.mock.calls.length).toBe(1);
    expect(settled).toBe(false);
    expect(readRuntimeJson(join(f.home, `${f.session.id}.turns.json`))).toMatchObject({
      count: 1,
      prompt: 'keep working',
    });
    await expect(answer).resolves.toBe('reply:1:keep working');
    expect(dispatched).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it('refuses cross-profile and failed durable admissions before reaching the provider', async () => {
  const f = await fixture();
  try {
    const signal = new AbortController().signal;
    const other = f.profiles.create({ name: 'other', branch_prefix: '' });
    await expect(
      f.turns.ask(f.binding.runtime_id, { ...f.scope, profileId: other.id }, 'forbidden', signal),
    ).rejects.toMatchObject({ code: 'profile_scope' });
    f.db.exec(
      "CREATE TRIGGER fail_turn_intent BEFORE INSERT ON puddlang_runtime_turns BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END",
    );
    await expect(f.turns.ask(f.binding.runtime_id, f.scope, 'unsaved', signal)).rejects.toThrow(
      'storage unavailable',
    );
    expect(f.db.prepare('SELECT * FROM puddlang_runtime_turns').all()).toEqual([]);
    expect(existsSync(join(f.home, `${f.session.id}.turns.json`))).toBe(false);
    f.db.exec('DROP TRIGGER fail_turn_intent');
    await expect(f.turns.ask(f.binding.runtime_id, f.scope, 'saved', signal)).resolves.toBe(
      'reply:1:saved',
    );
  } finally {
    await f.close();
  }
});
