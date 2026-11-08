import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, onTestFinished } from 'vitest';
import { openDatabase } from '../../src/db/db.js';
import { MIGRATIONS } from '../../src/db/migrations/index.js';
import { ProfileStore } from '../../src/db/stores/profiles.js';
import { LayoutStore } from '../../src/db/stores/layouts.js';

it('migrates legacy named trees without inventing native ownership, and retains them on reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-window-layouts-'));
  const file = join(directory, 'puddle.db');
  let db = new Database(file);
  onTestFinished(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const migration of MIGRATIONS.filter(({ version }) => version <= 41)) {
    db.exec(migration.sql);
    db.pragma(`user_version = ${migration.version}`);
  }
  const profile = new ProfileStore(db).create({ name: 'legacy', branch_prefix: '' });
  const tree = { kind: 'leaf', id: 'old-pane', tabs: [], activeKey: null, previewKey: null };
  const now = new Date().toISOString();
  const row = db
    .prepare(
      `INSERT INTO layouts
    (profile_id, scope, name, layout_tree, active_session, created_at, updated_at)
    VALUES (?, 'profile', 'old layout', ?, NULL, ?, ?)`,
    )
    .run(profile.id, JSON.stringify(tree), now, now);
  db.close();
  db = openDatabase(file);
  const saved = new LayoutStore(db).get(Number(row.lastInsertRowid));
  expect(saved.layout_tree).toEqual(tree);
  expect(saved.window_arrangement).toBeUndefined();
  expect(saved.created_at).toBe(now);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  db.close();
  db = openDatabase(file);
  expect(new LayoutStore(db).get(saved.id)).toEqual(saved);
  const native = new LayoutStore(db).update(saved.id, {
    layout_tree: tree as NonNullable<typeof saved.layout_tree>,
    window_arrangement: {
      version: 1,
      windows: [
        {
          key: 'host',
          kind: 'host',
          project_id: null,
          layout_mode: 'profile',
          layout_tree: null,
          active_session: null,
          project_layouts: {},
        },
      ],
    },
  });
  db.close();
  db = openDatabase(file);
  expect(new LayoutStore(db).get(saved.id)).toEqual(native);
  db.prepare('UPDATE layouts SET window_arrangement = ? WHERE id = ?').run(
    JSON.stringify({ ...native.window_arrangement, version: 2 }),
    saved.id,
  );
  expect(() => new LayoutStore(db).get(saved.id)).toThrow();
});
