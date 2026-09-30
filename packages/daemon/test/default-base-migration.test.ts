import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, onTestFinished } from 'vitest';
import { openDatabase } from '../src/db/db.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { ProfileStore } from '../src/db/stores/profiles.js';
import { ProjectStore } from '../src/db/stores/projects.js';
import { RepoStore } from '../src/db/stores/repos.js';
import { SessionStore } from '../src/db/stores/sessions.js';

function databaseFile() {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-base-migration-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'puddle.db');
}

it('clears every legacy repository default once while preserving settings and placements', () => {
  const file = databaseFile();
  let db = new Database(file);
  onTestFinished(() => db.close());
  for (const migration of MIGRATIONS.filter(({ version }) => version <= 22)) {
    db.exec(migration.sql);
    db.pragma(`user_version = ${migration.version}`);
  }
  db.pragma('foreign_keys = ON');
  const repos = new RepoStore(db);
  const profiles = new ProfileStore(db);
  const projects = new ProjectStore(db);
  const sessions = new SessionStore(db);
  const profile = profiles.create({ name: 'test', branch_prefix: 'test/' });
  for (const [index, base] of ['main', 'release/stable', ''].entries()) {
    const repo = repos.create({
      path: `/tmp/repo-${index}`,
      default_base_branch: base,
      onboarding_notes: index === 0 ? null : 'Run the setup script.',
      fetch_enabled: index !== 1,
    });
    repos.setLastFetchedAt(repo.id, '2026-09-01T00:00:00.000Z');
    const project = projects.create({
      profile_id: profile.id,
      repo_id: repo.id,
      name: `project-${index}`,
    });
    sessions.create({
      id: randomUUID(),
      project_id: project.id,
      account_id: null,
      worktree_path: `/tmp/worktree-${index}`,
      base_branch: base || 'develop',
      branch: `test/topic-${index}`,
      separate_branch: true,
      kind: 'terminal',
      agent_type: null,
      title: 'Existing placement',
      skip_permissions: false,
      status: 'exited',
    });
  }
  const oldRepos = repos.list();
  const oldProjects = db.prepare('SELECT * FROM projects ORDER BY id').all();
  const oldSessions = db.prepare('SELECT * FROM sessions ORDER BY id').all();
  db.close();

  db = openDatabase(file);
  expect(new RepoStore(db).list()).toEqual(
    oldRepos.map((repo) => ({ ...repo, default_base_branch: '' })),
  );
  expect(db.prepare('SELECT * FROM projects ORDER BY id').all()).toEqual(oldProjects);
  expect(db.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(oldSessions);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

  new RepoStore(db).patch(oldRepos[0]!.id, { default_base_branch: 'chosen/after-upgrade' });
  db.close();
  db = openDatabase(file);
  expect(new RepoStore(db).get(oldRepos[0]!.id).default_base_branch).toBe('chosen/after-upgrade');
  expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
});

it('uses an empty SQLite default for new repositories and retains path uniqueness', () => {
  const db = openDatabase(databaseFile());
  onTestFinished(() => db.close());
  const { lastInsertRowid } = db
    .prepare('INSERT INTO repos (path) VALUES (?)')
    .run('/tmp/new-repo');
  expect(new RepoStore(db).get(Number(lastInsertRowid))).toMatchObject({
    default_base_branch: '',
    fetch_enabled: true,
    onboarding_notes: null,
    last_fetched_at: null,
  });
  expect(() => db.prepare('INSERT INTO repos (path) VALUES (?)').run('/tmp/new-repo')).toThrow(
    /UNIQUE/,
  );
});
