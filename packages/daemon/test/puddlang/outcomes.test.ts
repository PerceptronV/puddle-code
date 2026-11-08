import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { puddlangOutcomeResponseSchema, puddlangOutcomesSchema } from '@puddle/shared';
import { programmeTurnFixture } from '../helpers/runtime/programme-turns.js';
import { dropResultCapacity } from '../helpers/runtime/result-capacity.js';
import { puddlangRoutes } from '../../src/http/routes/execution/puddlang.js';
import type { PuddlangService } from '../../src/puddlang/service.js';
import { ApiError } from '../../src/http/errors.js';
import { openDatabase } from '../../src/db/db.js';
import { PuddlangStore } from '../../src/puddlang/store.js';
import { ProfileStore } from '../../src/db/stores/profiles.js';
import { ProjectStore } from '../../src/db/stores/projects.js';
import { AccountStore } from '../../src/db/stores/accounts.js';
import { RepoStore } from '../../src/db/stores/repos.js';
import { profileAccessMiddleware } from '../../src/security/profile-access.js';

const allow = () => true;

it('reads an interrupted programme outcome explicitly, audits once and frees capacity without replay', async () => {
  const f = programmeTurnFixture();
  try {
    for (let turn = 1; turn <= 128; turn++) {
      f.reserve(turn);
      f.save(turn, `private-${turn}`);
    }
    f.runs.finish(f.run.id, 'interrupted');
    expect(() => f.consume(1)).toThrow(); // Live runner authority stays fenced.
    expect(() => f.observations.reserveTurnCapacity(f.binding.runtime_id)).toThrow(/full/);
    const first = f.runs.outcomes.list(f.profile.id, f.run.id).outcomes[0]!;
    expect(first).toMatchObject({
      operation_id: 1,
      retained: true,
      consumed: false,
      disposition: null,
    });
    expect(JSON.stringify(first)).not.toContain('private-');
    const request = { action: 'read' as const, fingerprint: first.fingerprint! };
    const read = f.runs.outcomes.dispose(f.profile.id, f.run.id, 1, request, allow);
    expect(read.result).toEqual({ status: 'completed', reply: 'private-1' });
    expect(read.outcome.consumed).toBe(true);
    expect(f.runs.outcomes.dispose(f.profile.id, f.run.id, 1, request, allow)).toEqual(read);
    const events = f.runs.events(f.profile.id, f.run.id, 0).events;
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('outcome_disposition');
    expect(JSON.stringify(events)).not.toContain('private-');
    f.observations.reserveTurnCapacity(f.binding.runtime_id);
    expect(f.observations.turn(f.binding.runtime_id, 1)).toBeNull();
    const repeated = f.runs.outcomes.dispose(f.profile.id, f.run.id, 1, request, allow);
    expect(repeated).toMatchObject({
      outcome: { retained: false, consumed: true, disposition: read.outcome.disposition },
      result: null,
    });
    expect(f.runs.get(f.profile.id, f.run.id).status).toBe('interrupted');
    expect(f.db.prepare('SELECT turn FROM runtime_turn_watermarks').get()).toEqual({ turn: 128 });
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM puddlang_runtime_turns').get()).toEqual({
      count: 128,
    });
  } finally {
    await f.close();
  }
});

it('discards without exposing reply text and rejects a changed action, fingerprint or profile', async () => {
  const f = programmeTurnFixture();
  try {
    f.reserve(1);
    f.save(1, 'private response');
    f.runs.finish(f.run.id, 'failed');
    const first = f.runs.outcomes.list(f.profile.id, f.run.id).outcomes[0]!;
    const request = { action: 'discard' as const, fingerprint: first.fingerprint! };
    expect(() => f.runs.outcomes.dispose('0000000000', f.run.id, 1, request, allow)).toThrow();
    expect(() => f.runs.outcomes.dispose(f.profile.id, f.run.id, 2, request, allow)).toThrow();
    expect(() =>
      f.runs.outcomes.dispose(
        f.profile.id,
        f.run.id,
        1,
        { ...request, fingerprint: '0'.repeat(64) },
        allow,
      ),
    ).toThrow(/Inspect/);
    const discarded = f.runs.outcomes.dispose(f.profile.id, f.run.id, 1, request, allow);
    expect(discarded.result).toBeNull();
    expect(JSON.stringify(discarded)).not.toContain('private response');
    expect(() =>
      f.runs.outcomes.dispose(f.profile.id, f.run.id, 1, { ...request, action: 'read' }, allow),
    ).toThrow(/different/);
    expect(f.runs.events(f.profile.id, f.run.id, 0).events).toHaveLength(1);
    // A runtime that no longer belongs to this profile is never exposed through an old mapping.
    const other = new ProfileStore(f.db).create({ name: 'foreign', branch_prefix: '' });
    f.db
      .prepare('UPDATE runtime_bindings SET profile_id = ? WHERE runtime_id = ?')
      .run(other.id, f.binding.runtime_id);
    expect(() => f.runs.outcomes.list(f.profile.id, f.run.id)).toThrow();
    expect(() => f.runs.outcomes.dispose(f.profile.id, f.run.id, 1, request, allow)).toThrow();
  } finally {
    await f.close();
  }
});

it('preserves unknown/running outcomes and rejects a running programme or revoked authority', async () => {
  const f = programmeTurnFixture();
  try {
    f.reserve(1);
    expect(f.runs.outcomes.list(f.profile.id, f.run.id).outcomes[0]).toMatchObject({
      status: 'unavailable',
      retained: false,
      fingerprint: null,
    });
    f.observations.saveTurn(f.binding, { turn: 1, expected_ref: null, status: 'running' });
    const request = { action: 'discard' as const, fingerprint: '0'.repeat(64) };
    expect(() => f.runs.outcomes.dispose(f.profile.id, f.run.id, 1, request, allow)).toThrow(
      /programme/,
    );
    f.runs.finish(f.run.id, 'interrupted');
    expect(() => f.runs.outcomes.dispose(f.profile.id, f.run.id, 1, request, allow)).toThrow(
      /terminal outcome/,
    );
    f.observations.saveTurn(f.binding, {
      turn: 1,
      expected_ref: null,
      status: 'failed',
      error: 'private failure',
    });
    request.fingerprint = f.runs.outcomes.list(f.profile.id, f.run.id).outcomes[0]!.fingerprint!;
    let checks = 0;
    expect(() =>
      f.runs.outcomes.dispose(f.profile.id, f.run.id, 1, request, () => ++checks < 3),
    ).toThrow(/authority/);
    expect(f.db.prepare('SELECT consumed FROM runtime_turns').get()).toEqual({ consumed: 0 });
    expect(
      f.db.prepare('SELECT COUNT(*) AS count FROM puddlang_outcome_dispositions').get(),
    ).toEqual({ count: 0 });
    expect(f.runs.events(f.profile.id, f.run.id, 0).events).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it('rolls back consumption and the immutable audit if event persistence fails', async () => {
  const f = programmeTurnFixture();
  try {
    f.reserve(1);
    f.save(1);
    f.runs.finish(f.run.id, 'interrupted');
    const request = {
      action: 'read' as const,
      fingerprint: f.runs.outcomes.list(f.profile.id, f.run.id).outcomes[0]!.fingerprint!,
    };
    f.db.exec(
      "CREATE TRIGGER reject_disposition BEFORE INSERT ON puddlang_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    expect(() => f.runs.outcomes.dispose(f.profile.id, f.run.id, 1, request, allow)).toThrow(
      /audit unavailable/,
    );
    expect(f.db.prepare('SELECT consumed FROM runtime_turns').get()).toEqual({ consumed: 0 });
    expect(
      f.db.prepare('SELECT COUNT(*) AS count FROM puddlang_outcome_dispositions').get(),
    ).toEqual({ count: 0 });
    f.db.exec('DROP TRIGGER reject_disposition');
    expect(f.runs.outcomes.dispose(f.profile.id, f.run.id, 1, request, allow).result?.reply).toBe(
      'reply-1',
    );
  } finally {
    await f.close();
  }
});

it('paginates exact operation metadata and validates explicit HTTP requests and authority', async () => {
  const f = programmeTurnFixture();
  try {
    for (let turn = 1; turn <= 51; turn++) {
      f.reserve(turn);
      f.save(turn);
    }
    f.runs.finish(f.run.id, 'cancelled');
    let authorised = true;
    const app = new Hono<{ Variables: { authorityValid: () => boolean; remoteProfile: string } }>();
    app.use('*', async (c, next) => {
      c.set('authorityValid', () => authorised);
      await next();
    });
    app.onError((error, c) =>
      c.json({ error: error.message }, error instanceof ApiError ? (error.status as 400) : 500),
    );
    // The route only needs the existing store for inspection/disposition; no runner is launched.
    app.route('/api/puddlang', puddlangRoutes({ store: f.runs } as PuddlangService));
    const base = `/api/puddlang/${f.profile.id}/runs/${f.run.id}/outcomes`;
    const first = puddlangOutcomesSchema.parse(await (await app.request(base)).json());
    expect(first.outcomes).toHaveLength(50);
    expect(first.next_after).toBe(50);
    const next = puddlangOutcomesSchema.parse(await (await app.request(`${base}?after=50`)).json());
    expect(next.outcomes).toHaveLength(1);
    expect(next.next_after).toBeNull();
    expect((await app.request(`${base}?after=NaN`)).status).toBe(400);
    const request = { action: 'read', fingerprint: first.outcomes[0]!.fingerprint };
    const send = (body: unknown) =>
      app.request(`${base}/1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await send({ ...request, runtime: randomUUID() })).status).toBe(400);
    expect((await send({ action: 'discard' })).status).toBe(400);
    authorised = false;
    expect((await send(request)).status).toBe(401);
    authorised = true;
    const read = puddlangOutcomeResponseSchema.parse(await (await send(request)).json());
    expect(read.result?.reply).toBe('reply-1');
    expect(f.runs.events(f.profile.id, f.run.id, 0).events).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('preserves explicit disposition across reopening without inferring old unread results were consumed', async () => {
  const f = programmeTurnFixture();
  f.reserve(1);
  f.save(1);
  f.reserve(2);
  f.save(2);
  f.runs.finish(f.run.id, 'interrupted');
  const request = {
    action: 'read' as const,
    fingerprint: f.runs.outcomes.list(f.profile.id, f.run.id).outcomes[0]!.fingerprint!,
  };
  f.runs.outcomes.dispose(f.profile.id, f.run.id, 1, request, allow);
  await f.close();
  const db = openDatabase(f.paths.dbFile);
  try {
    const store = new PuddlangStore(db);
    expect(store.outcomes.dispose(f.profile.id, f.run.id, 1, request, allow).result?.reply).toBe(
      'reply-1',
    );
    expect(store.outcomes.list(f.profile.id, f.run.id).outcomes[1]).toMatchObject({
      consumed: false,
      disposition: null,
    });
    expect(store.events(f.profile.id, f.run.id, 0).events).toHaveLength(1);
  } finally {
    db.close();
  }
});

it('keeps both outcome inspection and disposition outside remote profile authority', async () => {
  const f = programmeTurnFixture();
  try {
    f.reserve(1);
    f.save(1);
    f.runs.finish(f.run.id, 'interrupted');
    const app = new Hono<{ Variables: { authorityValid: () => boolean; remoteProfile: string } }>();
    app.onError((error, c) =>
      c.json({ error: error.message }, error instanceof ApiError ? (error.status as 400) : 500),
    );
    app.use('*', async (c, next) => {
      c.set('remoteProfile', f.profile.id);
      c.set('authorityValid', allow);
      await next();
    });
    app.use(
      '*',
      profileAccessMiddleware({
        profiles: f.profiles,
        projects: new ProjectStore(f.db),
        accounts: new AccountStore(f.db),
        repos: new RepoStore(f.db),
        sessions: f.sessions,
        service: { list: () => [] },
      }),
    );
    app.route('/api/puddlang', puddlangRoutes({ store: f.runs } as PuddlangService));
    const path = `/api/puddlang/${f.profile.id}/runs/${f.run.id}/outcomes`;
    expect((await app.request(path)).status).toBe(403);
    expect(
      (
        await app.request(`${path}/1`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'read',
            fingerprint: f.runs.outcomes.list(f.profile.id, f.run.id).outcomes[0]!.fingerprint,
          }),
        })
      ).status,
    ).toBe(403);
    expect(f.db.prepare('SELECT consumed FROM runtime_turns').get()).toEqual({ consumed: 0 });
    expect(f.runs.events(f.profile.id, f.run.id, 0).events).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it('adds disposition audit storage to schema39 without releasing existing unread outcomes', async () => {
  const f = programmeTurnFixture();
  f.reserve(1);
  f.save(1);
  f.runs.finish(f.run.id, 'interrupted');
  f.db.exec('DROP TABLE puddlang_outcome_dispositions; PRAGMA user_version = 39');
  f.db.exec('ALTER TABLE layouts DROP COLUMN window_arrangement');
  f.db.exec(`DROP TRIGGER huddle_session_insert;
    DROP TRIGGER huddle_session_update;
    DROP INDEX idx_huddle_definition_placement;
    ALTER TABLE sessions DROP COLUMN huddle_id;
    ALTER TABLE runtime_bindings DROP COLUMN role;
    ALTER TABLE runtime_bindings DROP COLUMN huddle_id;
    ALTER TABLE runtime_bindings DROP COLUMN huddle_capabilities;`);
  dropResultCapacity(f.db);
  await f.close();
  const db = openDatabase(f.paths.dbFile);
  try {
    const store = new PuddlangStore(db);
    const outcome = store.outcomes.list(f.profile.id, f.run.id).outcomes[0]!;
    expect(outcome).toMatchObject({ retained: true, consumed: false, disposition: null });
    expect(
      store.outcomes.dispose(
        f.profile.id,
        f.run.id,
        1,
        { action: 'discard', fingerprint: outcome.fingerprint! },
        allow,
      ).result,
    ).toBeNull();
    expect(db.prepare('SELECT consumed FROM runtime_turns').get()).toEqual({ consumed: 1 });
  } finally {
    db.close();
  }
});
