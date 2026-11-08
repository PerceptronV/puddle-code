import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, onTestFinished } from 'vitest';
import { openDatabase } from '../../src/db/db.js';
import { MIGRATIONS } from '../../src/db/migrations/index.js';
import { AccountStore } from '../../src/db/stores/accounts.js';
import { ConversationStore } from '../../src/db/stores/conversations.js';
import { EventStore } from '../../src/db/stores/events.js';
import { ProfileStore } from '../../src/db/stores/profiles.js';
import { RepoStore } from '../../src/db/stores/repos.js';
import { SessionStore } from '../../src/db/stores/sessions.js';

it('migrates saved scripted sessions to headless while preserving their state and history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-mode-migration-'));
  const file = join(directory, 'puddle.db');
  let db = new Database(file);
  onTestFinished(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const migration of MIGRATIONS.filter(({ version }) => version <= 25)) {
    db.exec(migration.sql);
    db.pragma(`user_version = ${migration.version}`);
  }
  db.pragma('foreign_keys = ON');
  const profile = new ProfileStore(db).create({ name: 'test', branch_prefix: 'test/' });
  const repo = new RepoStore(db).create({
    path: '/tmp/test-repo',
    default_base_branch: '',
    onboarding_notes: null,
    fetch_enabled: true,
  });
  // Seed the historical schema independently of current project-store fields.
  const projectId = randomBytes(5).toString('hex');
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO projects (id, profile_id, repo_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(projectId, profile.id, repo.id, 'test', now, now);
  const account = new AccountStore(db).create({
    profile_id: profile.id,
    agent_type: 'codex',
    label: 'primary',
    config_dir: '/tmp/test-account',
    skip_permissions_default: false,
  });
  let migratedId = '';
  for (const mode of ['interactive', 'scripted']) {
    const conversation = new ConversationStore(db).upsert(profile.id, 'codex', account.id, {
      ref: randomUUID(),
      cwd: repo.path,
      title: mode,
      parentRef: null,
      createdAt: null,
      updatedAt: null,
    });
    // Historical fixtures use the historical columns, independently of today's store writer.
    const session = { id: randomUUID() };
    db.prepare(
      `INSERT INTO sessions (id, project_id, account_id, conversation_id,
      worktree_path, canonical_worktree_path, base_branch, branch, kind, agent_type,
      title, status, native_sync, skip_permissions, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'main', 'main', 'agent', 'codex', ?, 'interrupted', 'full', 0, ?, ?)`,
    ).run(session.id, projectId, account.id, conversation.id, repo.path, repo.path, mode, now, now);
    // Write the historical value directly: the current API only accepts headless.
    db.prepare('UPDATE sessions SET agent_mode = ?, session_env = ? WHERE id = ?').run(
      mode,
      JSON.stringify({ TEST_VARIABLE: 'retained' }),
      session.id,
    );
    new EventStore(db).record(session.id, 'created', { mode });
    if (mode === 'scripted') migratedId = session.id;
  }
  const rows = () =>
    db.prepare('SELECT * FROM sessions ORDER BY id').all() as Record<string, unknown>[];
  const before = rows();
  const events = db.prepare('SELECT * FROM events ORDER BY id').all();
  const conversations = db.prepare('SELECT * FROM agent_conversations ORDER BY id').all();
  db.close();

  db = openDatabase(file);
  const expected = before.map((row) => ({
    ...row,
    agent_mode: row['agent_mode'] === 'scripted' ? 'headless' : 'interactive',
    huddle_id: null,
  }));
  expect(rows()).toEqual(expected);
  expect(new SessionStore(db).get(migratedId).agent_mode).toBe('headless');
  expect(db.prepare('SELECT * FROM events ORDER BY id').all()).toEqual(events);
  expect(db.prepare('SELECT * FROM agent_conversations ORDER BY id').all()).toEqual(conversations);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(() => db.prepare("UPDATE sessions SET agent_mode = 'scripted'").run()).toThrow(/CHECK/);
  expect(() => db.prepare("UPDATE sessions SET agent_mode = 'unknown'").run()).toThrow(/CHECK/);
  expect(db.pragma('table_info(sessions)')).toContainEqual(
    expect.objectContaining({ name: 'agent_mode', dflt_value: "'interactive'" }),
  );

  db.close();
  db = openDatabase(file);
  expect(rows()).toEqual(expected);
  expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
});
