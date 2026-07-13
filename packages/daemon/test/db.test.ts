import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
});
