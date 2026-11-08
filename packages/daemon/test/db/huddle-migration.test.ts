import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, onTestFinished } from 'vitest';
import { runtimeIdentitySchema } from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import { openDatabase } from '../../src/db/db.js';
import { MIGRATIONS } from '../../src/db/migrations/index.js';
import { ProfileStore } from '../../src/db/stores/profiles.js';
import { ProjectStore } from '../../src/db/stores/projects.js';
import { RepoStore } from '../../src/db/stores/repos.js';
import { AccountStore } from '../../src/db/stores/accounts.js';
import { RuntimeStore } from '../../src/db/stores/runtimes.js';

it('migrates schema 42 without changing ordinary owner identities, fingerprints or terminal history', () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-huddle-migration-'));
  const file = join(home, 'db.sqlite');
  let db = new Database(file);
  onTestFinished(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  for (const migration of MIGRATIONS.filter(({ version }) => version <= 42)) {
    db.exec(migration.sql);
    db.pragma(`user_version = ${migration.version}`);
  }
  db.pragma('foreign_keys = ON');
  const profile = new ProfileStore(db).create({ name: 'test', branch_prefix: '' });
  const repo = new RepoStore(db).create({
    path: home,
    default_base_branch: 'main',
    onboarding_notes: null,
    fetch_enabled: false,
  });
  const project = new ProjectStore(db).create({
    profile_id: profile.id,
    repo_id: repo.id,
    name: 'test',
  });
  const account = new AccountStore(db).create({
    profile_id: profile.id,
    agent_type: 'codex',
    label: 'test',
    config_dir: home,
    skip_permissions_default: false,
  });
  const inputs = (['agent', 'terminal'] as const).map((kind) => {
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sessions (id, project_id, account_id, agent_type, kind,
      worktree_path, canonical_worktree_path, base_branch, branch, separate_branch,
      title, status, skip_permissions, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'main', 'main', 0, ?, 'running', 0, ?, ?)`,
    ).run(
      sessionId,
      project.id,
      kind === 'agent' ? account.id : null,
      kind === 'agent' ? 'codex' : null,
      kind,
      home,
      home,
      kind,
      now,
      now,
    );
    const identity = runtimeIdentitySchema.parse({
      runtime_id: randomUUID(),
      incarnation: randomUUID(),
      launch_id: randomUUID(),
      profile_id: profile.id,
      project_id: project.id,
      session_id: sessionId,
      canonical_worktree_path: home,
    });
    const input = {
      identity,
      build: 'old-runtime',
      protocol: { major: 1, minor: 0 },
      releasePath: home,
    };
    const fingerprint = digest(JSON.stringify(input));
    db.prepare(
      `INSERT INTO runtime_bindings (runtime_id, incarnation, launch_id, launch_fingerprint,
      profile_id, project_id, launch_session_id, active_session_id, active_segment_id,
      account_id, agent_type, canonical_worktree_path, build, protocol_major, protocol_minor,
      release_path, state, event_cursor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, 'running', 7, ?)`,
    ).run(
      identity.runtime_id,
      identity.incarnation,
      identity.launch_id,
      fingerprint,
      profile.id,
      project.id,
      sessionId,
      sessionId,
      identity.runtime_id,
      kind === 'agent' ? account.id : null,
      kind === 'agent' ? 'codex' : null,
      home,
      input.build,
      home,
      now,
    );
    db.prepare(
      'INSERT INTO runtime_segments (runtime_id, segment_id, session_id, start_cursor) VALUES (?, ?, ?, 0)',
    ).run(identity.runtime_id, identity.runtime_id, sessionId);
    db.prepare('INSERT INTO terminal_placements (session_id, runtime_id) VALUES (?, ?)').run(
      sessionId,
      identity.runtime_id,
    );
    db.prepare(
      "INSERT INTO runtime_segment_terminals (segment_id, term, generation) VALUES (?, 'agent', ?)",
    ).run(identity.runtime_id, randomUUID());
    return input;
  });
  const tables = [
    'sessions',
    'runtime_bindings',
    'runtime_segments',
    'terminal_placements',
    'runtime_segment_terminals',
  ];
  const snapshot = () =>
    Object.fromEntries(
      tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    );
  const before = snapshot();
  db.close();
  db = openDatabase(file);
  expect(snapshot()).toEqual({
    ...before,
    sessions: before['sessions']!.map((row) => ({ ...(row as object), huddle_id: null })),
    runtime_bindings: before['runtime_bindings']!.map((row) => ({
      ...(row as object),
      role: 'session',
      huddle_id: null,
      huddle_capabilities: null,
    })),
  });
  for (const input of inputs) {
    const store = new RuntimeStore(db);
    expect(store.prepare(input)).toEqual(store.ownerOf(input.identity.session_id));
    expect(store.usesExternalTerminals(input.identity.session_id)).toBe(true);
  }
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
