import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db/db.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { AccountStore } from '../src/db/stores/accounts.js';
import { EventStore } from '../src/db/stores/events.js';
import { ProfileStore } from '../src/db/stores/profiles.js';
import { ProjectStore } from '../src/db/stores/projects.js';
import { RepoStore } from '../src/db/stores/repos.js';
import { SessionStore } from '../src/db/stores/sessions.js';
import { ApiError } from '../src/http/errors.js';

function freshDbFile() {
  return join(mkdtempSync(join(tmpdir(), 'puddle-db-')), 'puddle.db');
}

function stores() {
  const db = openDatabase(freshDbFile());
  return {
    db,
    profiles: new ProfileStore(db),
    accounts: new AccountStore(db),
    repos: new RepoStore(db),
    projects: new ProjectStore(db),
    sessions: new SessionStore(db),
    events: new EventStore(db),
  };
}

function seedSession(s: ReturnType<typeof stores>) {
  const profile = s.profiles.create({ name: 'alice', branch_prefix: 'alice/' });
  const account = s.accounts.create({
    profile_id: profile.id,
    agent_type: 'claude-code',
    label: 'personal',
    config_dir: '/tmp/cfg',
    skip_permissions_default: false,
  });
  const repo = s.repos.create({
    path: '/tmp/my-repo',
    default_base_branch: 'main',
    onboarding_notes: null,
    fetch_enabled: true,
  });
  const project = s.projects.create({ profile_id: profile.id, repo_id: repo.id, name: 'demo' });
  const session = s.sessions.create({
    id: 'a2f0c9d4-1111-4222-8333-444455556666',
    project_id: project.id,
    account_id: account.id,
    worktree_path: '/tmp/wt',
    base_branch: 'main',
    branch: 'alice/demo',
    kind: 'agent',
    agent_type: 'claude-code',
    title: 'demo',
    skip_permissions: false,
  });
  return { profile, account, repo, project, session };
}

describe('openDatabase', () => {
  it('applies all migrations and records user_version', () => {
    const { db } = stores();
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    for (const t of [
      'profiles',
      'accounts',
      'repos',
      'projects',
      'project_states',
      'sessions',
      'prompts',
      'events',
    ]) {
      expect(tables).toContain(t);
    }
  });

  it('is idempotent across reopen', () => {
    const file = freshDbFile();
    openDatabase(file).close();
    const db = openDatabase(file);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
  });

  it('enforces foreign keys', () => {
    const { db } = stores();
    expect(() =>
      db
        .prepare(
          `INSERT INTO accounts (profile_id, agent_type, label, config_dir, created_at)
           VALUES (999, 'claude-code', 'x', '/tmp/x', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe('stores', () => {
  it('round-trips a profile with settings', () => {
    const s = stores();
    const p = s.profiles.create({ name: 'alice', branch_prefix: 'alice/' });
    expect(p.branch_prefix).toBe('alice/');
    expect(s.profiles.getSettings(p.id).allowSkipPermissions).toBe(false);
    const patched = s.profiles.patchSettings(p.id, { allowSkipPermissions: true });
    expect(patched.allowSkipPermissions).toBe(true);
    expect(s.profiles.getSettings(p.id).allowSkipPermissions).toBe(true);
  });

  it('rejects duplicate profile names with a 409', () => {
    const s = stores();
    s.profiles.create({ name: 'alice', branch_prefix: '' });
    try {
      s.profiles.create({ name: 'alice', branch_prefix: '' });
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).status).toBe(409);
    }
  });

  it('renames a profile and rejects a clash with a 409', () => {
    const s = stores();
    const p = s.profiles.create({ name: 'alice', branch_prefix: 'alice/' });
    s.profiles.create({ name: 'bob', branch_prefix: 'bob/' });
    expect(s.profiles.setName(p.id, 'alice2').name).toBe('alice2');
    try {
      s.profiles.setName(p.id, 'bob'); // taken
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).status).toBe(409);
    }
  });

  it('throws 404 for a missing row', () => {
    const s = stores();
    try {
      s.profiles.get(42);
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).status).toBe(404);
    }
  });

  it('maps account booleans', () => {
    const s = stores();
    const { account } = seedSession(s);
    expect(account.logged_in).toBe(false);
    s.accounts.setLoggedIn(account.id, true);
    expect(s.accounts.get(account.id).logged_in).toBe(true);
  });

  it('creates and transitions sessions', () => {
    const s = stores();
    const { session, repo } = seedSession(s);
    expect(session.status).toBe('starting');
    const running = s.sessions.setStatus(session.id, 'running');
    expect(running.status).toBe('running');
    expect(s.sessions.list({ status: 'running' })).toHaveLength(1);
    expect(s.sessions.listActiveByRepo(repo.id)).toHaveLength(1);
    s.sessions.setStatus(session.id, 'archived');
    expect(s.sessions.listActiveByRepo(repo.id)).toHaveLength(0);
  });

  it('patches repos and records fetch times', () => {
    const s = stores();
    const { repo } = seedSession(s);
    const patched = s.repos.patch(repo.id, { onboarding_notes: 'always pnpm install' });
    expect(patched.onboarding_notes).toBe('always pnpm install');
    s.repos.setLastFetchedAt(repo.id, '2026-07-13T00:00:00.000Z');
    expect(s.repos.get(repo.id).last_fetched_at).toBe('2026-07-13T00:00:00.000Z');
  });

  it('records events with JSON payloads', () => {
    const s = stores();
    const { session } = seedSession(s);
    s.events.record(session.id, 'created', { branch: 'alice/demo' });
    const events = s.events.list(session.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ branch: 'alice/demo' });
  });

  it('migrations remap integer project and profile ids to hex across every table', () => {
    // Build a version-1 database with data, exactly as Phase 1 wrote it.
    const file = freshDbFile();
    const v1 = new Database(file);
    v1.pragma('foreign_keys = ON');
    v1.exec(MIGRATIONS[0]!.sql);
    v1.pragma('user_version = 1');
    v1.exec(`
      INSERT INTO profiles (id, name, branch_prefix, created_at) VALUES (1, 'alice', 'alice/', 't');
      INSERT INTO repos (id, path) VALUES (1, '/tmp/repo');
      INSERT INTO projects (id, profile_id, repo_id, name, created_at, updated_at)
        VALUES (7, 1, 1, 'demo', 't', 't');
      INSERT INTO accounts (id, profile_id, agent_type, label, config_dir, created_at)
        VALUES (1, 1, 'fake', 'personal', '/tmp/home/profiles/alice/accounts/fake/personal', 't');
      INSERT INTO sessions (id, project_id, account_id, worktree_path, base_branch, branch,
                            agent_type, status, created_at, updated_at)
        VALUES ('11111111-1111-4111-8111-111111111111', 7, 1, '/tmp/wt', 'main', 'alice/x',
                'fake', 'archived', 't', 't');
      INSERT INTO project_states (project_id, client_id, ui_state, updated_at)
        VALUES (7, 'client-a', '{}', 't');
      INSERT INTO events (session_id, type, created_at)
        VALUES ('11111111-1111-4111-8111-111111111111', 'created', 't');
    `);
    v1.close();

    const db = openDatabase(file); // runs migrations 002–004
    const project = db.prepare(`SELECT * FROM projects`).get() as { id: string; name: string };
    expect(project.id).toMatch(/^[0-9a-f]{10}$/);
    expect(project.name).toBe('demo');
    const session = db.prepare(`SELECT project_id FROM sessions`).get() as { project_id: string };
    expect(session.project_id).toBe(project.id);
    // Migration 004 gives profiles hex ids and rewrites config-dir paths.
    const profile = db.prepare(`SELECT * FROM profiles`).get() as { id: string; name: string };
    expect(profile.id).toMatch(/^[0-9a-f]{10}$/);
    expect(profile.name).toBe('alice');
    const account = db.prepare(`SELECT profile_id, config_dir FROM accounts`).get() as {
      profile_id: string;
      config_dir: string;
    };
    expect(account.profile_id).toBe(profile.id);
    expect(account.config_dir).toBe(`/tmp/home/profiles/${profile.id}/accounts/fake/personal`);
    expect(db.prepare(`SELECT profile_id FROM projects`).get()).toEqual({
      profile_id: profile.id,
    });
    // Migration 003 re-keys the layout row to the project's owning profile.
    const state = db.prepare(`SELECT project_id, profile_id FROM project_states`).get() as {
      project_id: string;
      profile_id: string;
    };
    expect(state.project_id).toBe(project.id);
    expect(state.profile_id).toBe(profile.id);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM events`).get()).toEqual({ n: 1 });
    db.close();
  });
});
