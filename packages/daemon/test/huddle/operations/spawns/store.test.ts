import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RUNTIME_PROTOCOL_VERSION, type HuddleSpawnScope } from '@puddle/shared';
import {
  HuddleSpawnStore,
  HUDDLE_SPAWN_LIMITS,
} from '../../../../src/huddle/operations/spawns/store.js';
import { AccountStore } from '../../../../src/db/stores/accounts.js';
import { ProjectStore } from '../../../../src/db/stores/projects.js';
import { SessionStore } from '../../../../src/db/stores/sessions.js';
import { RuntimeStore } from '../../../../src/db/stores/runtimes.js';
import { openDatabase } from '../../../../src/db/db.js';
import { DATABASE_SCHEMA_VERSION } from '../../../../src/db/migrations/index.js';
import { reconcilePass } from '../../../../src/sessions/reconcile.js';
import type { MarkerFileSync } from '../../../../src/sessions/onboarding.js';
import { runtimeDatabase } from '../../../helpers/runtime-database.js';
import { huddleTurnScope } from '../../../helpers/huddle/agent-turns.js';
import { writeHistoricalDatabase } from '../../../helpers/db/historical.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function fixture() {
  const f = runtimeDatabase('headless');
  cleanups.push(async () => {
    await f.reconciler.close();
    f.db.close();
  });
  const { target: _, ...scope } = huddleTurnScope(f);
  new AccountStore(f.db).setLoggedIn(f.account!.id, true);
  let dispatch = true;
  const authority = (mode: 'dispatch' | 'observe') => mode === 'observe' || dispatch;
  const request = {
    projectId: f.project.id,
    worktree: f.launch.identity.canonical_worktree_path,
    accountId: f.account!.id,
    agent: 'runtime-test',
    mode: 'headless' as const,
    title: 'Spawned agent',
  };
  const store = new HuddleSpawnStore(f.db);
  const bound = store.bind(scope, request, authority);
  const row = {
    id: randomUUID(),
    project_id: request.projectId,
    account_id: request.accountId,
    worktree_path: request.worktree,
    base_branch: 'main',
    branch: 'main',
    separate_branch: false,
    kind: 'agent' as const,
    agent_type: request.agent,
    agent_mode: request.mode,
    title: request.title,
    skip_permissions: false,
  };
  const launch = {
    identity: {
      ...f.launch.identity,
      session_id: row.id,
      runtime_id: randomUUID(),
      incarnation: randomUUID(),
      launch_id: randomUUID(),
    },
    build: 'runtime-test',
    protocol: RUNTIME_PROTOCOL_VERSION,
    releasePath: f.directory,
    creation: bound.caller,
  };
  return {
    ...f,
    scope,
    request,
    store,
    bound,
    row,
    launch,
    authority,
    revoke: () => {
      dispatch = false;
    },
  };
}

it('commits a single placement with spawn intent and rolls both back on storage failure', () => {
  const f = fixture();
  f.db.exec(
    "CREATE TRIGGER fail_huddle_spawn BEFORE INSERT ON huddle_runtime_spawns BEGIN SELECT RAISE(ABORT, 'spawn storage unavailable'); END",
  );
  expect(() => f.sessions.create(f.row, undefined, f.bound.caller)).toThrow(
    'spawn storage unavailable',
  );
  expect(() => f.sessions.get(f.row.id)).toThrow();
  expect(f.bound.observe()).toBeNull();
  f.db.exec('DROP TRIGGER fail_huddle_spawn');
  f.sessions.create(f.row, undefined, f.bound.caller);
  expect(f.bound.observe()).toEqual({ sessionId: f.row.id, runtime: null, stopRequested: false });
  const duplicate = { ...f.row, id: randomUUID() };
  expect(() => f.sessions.create(duplicate, undefined, f.bound.caller)).toThrow('already created');
  expect(() => f.sessions.get(duplicate.id)).toThrow();
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM puddlang_runs').get()).toEqual({ n: 0 });
});

it('persists exact launch consumption across database reopen and never adopts a replacement', () => {
  const f = fixture();
  f.sessions.create(f.row, undefined, f.bound.caller);
  const original = f.runtimes.prepare(f.launch);
  const reopened = openDatabase(f.paths.dbFile);
  try {
    const bound = new HuddleSpawnStore(reopened).bind(f.scope, f.request, f.authority);
    expect(bound.observe()?.runtime).toEqual(f.launch.identity);
    const alternative = {
      ...f.launch,
      identity: {
        ...f.launch.identity,
        runtime_id: randomUUID(),
        launch_id: randomUUID(),
        incarnation: randomUUID(),
      },
      creation: bound.caller,
    };
    expect(() => new RuntimeStore(reopened).prepare(alternative)).toThrow();
    expect(new RuntimeStore(reopened).get(alternative.identity.runtime_id)).toBeNull();
    f.runtimes.finish(original.runtime_id, 'exited', () => {});
    expect(() => new RuntimeStore(reopened).prepare(alternative)).toThrow('already dispatched');
    const replacement = f.runtimes.prepare({ ...alternative, creation: undefined });
    bound.requestStop();
    expect(bound.observe()).toEqual({
      sessionId: f.row.id,
      runtime: f.launch.identity,
      stopRequested: true,
    });
    expect(f.runtimes.selectedOwner(f.row.id)?.runtime_id).toBe(replacement.runtime_id);
    expect(() =>
      new SessionStore(reopened).create({ ...f.row, id: randomUUID() }, undefined, bound.caller),
    ).toThrow('already created');
  } finally {
    reopened.close();
  }
});

it('rolls back runtime, terminal ownership and spawn binding together on binding storage failure', () => {
  const f = fixture();
  f.sessions.create(f.row, undefined, f.bound.caller);
  f.db.exec(
    "CREATE TRIGGER fail_huddle_bind BEFORE UPDATE OF runtime_id ON huddle_runtime_spawns BEGIN SELECT RAISE(ABORT, 'binding storage unavailable'); END",
  );
  expect(() => f.runtimes.prepare(f.launch)).toThrow('binding storage unavailable');
  expect(f.runtimes.get(f.launch.identity.runtime_id)).toBeNull();
  expect(
    f.db
      .prepare('SELECT 1 FROM runtime_segments WHERE runtime_id = ?')
      .get(f.launch.identity.runtime_id),
  ).toBeUndefined();
  expect(
    f.db.prepare('SELECT 1 FROM terminal_placements WHERE session_id = ?').get(f.row.id),
  ).toBeUndefined();
  expect(f.bound.observe()?.runtime).toBeNull();
});

it.each(['revocation', 'stop', 'account', 'archive'] as const)(
  'fences %s between placement and launch without creating runtime/segment records',
  (reason) => {
    const f = fixture();
    f.sessions.create(f.row, undefined, f.bound.caller);
    if (reason === 'revocation') f.revoke();
    if (reason === 'stop') f.bound.requestStop();
    if (reason === 'account') new AccountStore(f.db).setLoggedIn(f.account!.id, false);
    if (reason === 'archive') f.sessions.setStatus(f.scope.owner.session_id, 'archived');
    expect(() => f.runtimes.prepare(f.launch)).toThrow();
    expect(f.runtimes.get(f.launch.identity.runtime_id)).toBeNull();
    expect(
      f.db
        .prepare('SELECT 1 FROM runtime_segments WHERE runtime_id = ?')
        .get(f.launch.identity.runtime_id),
    ).toBeUndefined();
    expect(f.bound.observe()?.runtime).toBeNull();
  },
);

it('rejects changed retained scope/request and mismatched placement resources', () => {
  const f = fixture();
  expect(() =>
    f.sessions.create({ ...f.row, agent_mode: 'interactive' }, undefined, f.bound.caller),
  ).toThrow('differs');
  expect(() => f.sessions.get(f.row.id)).toThrow();
  f.sessions.create(f.row, undefined, f.bound.caller);
  for (const key of ['executionId', 'invocationId', 'activationId'] as const) {
    const scope: HuddleSpawnScope = { ...f.scope, [key]: randomUUID() };
    expect(() => f.store.bind(scope, f.request, f.authority).observe()).toThrow('intent changed');
  }
  expect(() =>
    f.store.bind(f.scope, { ...f.request, title: 'Substitute' }, f.authority).observe(),
  ).toThrow('intent changed');
  expect(() =>
    f.store
      .bind(
        { ...f.scope, owner: { ...f.scope.owner, incarnation: randomUUID() } },
        f.request,
        f.authority,
      )
      .observe(),
  ).toThrow('binding');
});

it.each(['execution', 'owner', 'host'] as const)(
  'bounds %s retention without evicting consumed spawn identities',
  (kind) => {
    const f = fixture();
    const store = new HuddleSpawnStore(f.db, { ...HUDDLE_SPAWN_LIMITS, [kind]: 1 });
    const bound = store.bind(f.scope, f.request, f.authority);
    f.sessions.create(f.row, undefined, bound.caller);
    const next = store.bind({ ...f.scope, operationId: randomUUID() }, f.request, f.authority);
    const row = { ...f.row, id: randomUUID() };
    expect(() => f.sessions.create(row, undefined, next.caller)).toThrow('retention is full');
    expect(() => f.sessions.get(row.id)).toThrow();
    expect(bound.observe()?.sessionId).toBe(f.row.id);
  },
);

it('does not auto-resume an undispatched spawn after controller replacement', () => {
  const f = fixture();
  f.sessions.create(f.row, undefined, f.bound.caller);
  const result = reconcilePass({
    ...f,
    projects: new ProjectStore(f.db),
    onboarding: { watch: vi.fn() } as unknown as MarkerFileSync,
  });
  expect(f.sessions.get(f.row.id).status).toBe('interrupted');
  expect(result.interrupted).not.toContain(f.row.id);
  expect(f.events.list(f.row.id)).toContainEqual(
    expect.objectContaining({
      type: 'interrupted',
      payload: { reason: 'huddle_spawn_not_dispatched' },
    }),
  );
  expect(f.bound.observe()?.runtime).toBeNull();
});

it('migrates schema 47 without changing retained session, owner, or huddle turn rows', () => {
  const f = fixture();
  const file = join(f.home, 'before-huddle-spawns.sqlite');
  writeHistoricalDatabase(f.db, file, 47);
  const migrated = openDatabase(file);
  try {
    expect(migrated.pragma('user_version', { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
    expect(migrated.prepare('SELECT * FROM huddle_runtime_spawns').all()).toEqual([]);
    for (const table of [
      'sessions',
      'runtime_bindings',
      'huddle_runtime_turns',
      'puddlang_runtime_spawns',
    ])
      expect(migrated.prepare(`SELECT * FROM ${table}`).all()).toEqual(
        f.db.prepare(`SELECT * FROM ${table}`).all(),
      );
  } finally {
    migrated.close();
  }
});

it('migrates admitted schema-48 spawns without inventing readiness or a cleanup attempt', () => {
  const f = fixture();
  f.sessions.create(f.row, undefined, f.bound.caller);
  f.runtimes.prepare(f.launch);
  f.bound.requestStop();
  const file = join(f.home, 'before-huddle-spawn-outcomes.sqlite');
  writeHistoricalDatabase(f.db, file, 48);
  const migrated = openDatabase(file);
  try {
    const bound = new HuddleSpawnStore(migrated).bind(f.scope, f.request, f.authority);
    expect(bound.observe()).toEqual(f.bound.observe());
    expect(bound.outcome()).toBeNull();
    expect(
      migrated.prepare('SELECT stop_requested, stop_attempted FROM huddle_runtime_spawns').get(),
    ).toEqual({ stop_requested: 1, stop_attempted: 0 });
  } finally {
    migrated.close();
  }
});

it('retains exactly one readiness result and refuses changed identity or corrupted receipts', () => {
  const f = fixture();
  f.sessions.create(f.row, undefined, f.bound.caller);
  f.runtimes.prepare(f.launch);
  f.db
    .prepare("UPDATE runtime_bindings SET state = 'running' WHERE runtime_id = ?")
    .run(f.launch.identity.runtime_id);
  const result = f.bound.ready(f.launch.identity);
  expect(f.bound.ready(f.launch.identity)).toEqual(result);
  expect(() => f.bound.ready({ ...f.launch.identity, incarnation: randomUUID() })).toThrow(
    'conflicts',
  );
  f.bound.requestStop();
  expect(f.bound.outcome()).toEqual(result);
  f.db
    .prepare("UPDATE huddle_runtime_spawns SET outcome = json_set(outcome, '$.receipt', ?)")
    .run('b'.repeat(64));
  expect(() => f.bound.outcome()).toThrow('outcome changed');
});

it('keeps readiness unknown if persistence fails and records it only after a successful transaction', () => {
  const f = fixture();
  f.sessions.create(f.row, undefined, f.bound.caller);
  f.runtimes.prepare(f.launch);
  f.db
    .prepare("UPDATE runtime_bindings SET state = 'running' WHERE runtime_id = ?")
    .run(f.launch.identity.runtime_id);
  f.db.exec(
    "CREATE TRIGGER fail_spawn_outcome BEFORE UPDATE OF outcome ON huddle_runtime_spawns BEGIN SELECT RAISE(ABORT, 'outcome storage unavailable'); END",
  );
  expect(() => f.bound.ready(f.launch.identity)).toThrow('outcome storage unavailable');
  expect(f.bound.outcome()).toBeNull();
  f.db.exec('DROP TRIGGER fail_spawn_outcome');
  expect(f.bound.ready(f.launch.identity)).toEqual(f.bound.outcome());
});
