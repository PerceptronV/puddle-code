import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HUDDLE_RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
  sessionSchema,
  createSessionRequestSchema,
} from '@puddle/shared';
import { openDatabase } from '../../../src/db/db.js';
import { HuddlePlacements } from '../../../src/db/stores/huddle/placements.js';
import { ProfileStore } from '../../../src/db/stores/profiles.js';
import { ProjectStore } from '../../../src/db/stores/projects.js';
import { RepoStore } from '../../../src/db/stores/repos.js';
import { SessionStore } from '../../../src/db/stores/sessions.js';
import { RuntimeStore } from '../../../src/db/stores/runtimes.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-huddle-placement-')));
  const file = join(home, 'db.sqlite');
  let db = openDatabase(file);
  cleanups.push(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const profile = new ProfileStore(db).create({ name: 'Huddles', branch_prefix: '' });
  const repo = new RepoStore(db).create({
    path: home,
    default_base_branch: 'main',
    onboarding_notes: null,
    fetch_enabled: false,
  });
  const project = new ProjectStore(db).create({
    profile_id: profile.id,
    repo_id: repo.id,
    name: 'Project',
  });
  const input = {
    projectId: project.id,
    worktree: home,
    huddleId: randomBytes(16).toString('hex'),
    branch: 'main',
    title: 'Review',
  };
  const open = (change: Partial<typeof input> = {}) =>
    new HuddlePlacements(db).open({ ...input, ...change });
  return {
    home,
    profile,
    project,
    input,
    open,
    get db() {
      return db;
    },
    reopen() {
      db.close();
      db = openDatabase(file);
    },
  };
}

describe('huddle application placements', () => {
  it('retains one stopped placement per project/worktree/definition across repeated open and reopen', () => {
    const f = fixture();
    const first = f.open();
    expect(first.created).toBe(true);
    expect(sessionSchema.parse(first.session)).toMatchObject({
      kind: 'huddle',
      huddle_id: f.input.huddleId,
      status: 'exited',
      account_id: null,
      agent_type: null,
      conversation_id: null,
      branch_owner: false,
    });
    expect(first.session.agent_mode).toBeUndefined();
    expect(f.open().session.id).toBe(first.session.id);
    expect(f.open().created).toBe(false);
    const alias = join(f.home, 'alias');
    symlinkSync(f.home, alias);
    expect(f.open({ worktree: alias }).session.id).toBe(first.session.id);
    new SessionStore(f.db).setStatus(first.session.id, 'archived');
    f.reopen();
    expect(f.open()).toMatchObject({
      created: false,
      session: { id: first.session.id, status: 'archived' },
    });
    expect(f.db.prepare('SELECT * FROM terminal_placements').all()).toEqual([]);
    expect(f.db.prepare('SELECT * FROM runtime_bindings').all()).toEqual([]);
  });
  it('allows multiple definitions per worktree and the same portable definition in another worktree', () => {
    const f = fixture();
    const first = f.open();
    const sibling = f.open({ huddleId: randomBytes(16).toString('hex') });
    const worktree = join(f.home, 'other');
    mkdirSync(worktree);
    const copied = f.open({ worktree });
    expect(new Set([first.session.id, sibling.session.id, copied.session.id]).size).toBe(3);
    expect(copied.session.huddle_id).toBe(first.session.huddle_id);
  });
  it('refuses implicit conversion, provider attachment and relocation of a huddle identity', () => {
    const f = fixture();
    const { session } = f.open();
    for (const [column, value] of [
      ['kind', 'terminal'],
      ['huddle_id', 'b'.repeat(32)],
      ['worktree_path', '/tmp/elsewhere'],
      ['agent_type', 'codex'],
      ['branch_owned', 1],
      ['skip_permissions', 1],
    ]) {
      expect(() =>
        f.db.prepare(`UPDATE sessions SET ${column} = ? WHERE id = ?`).run(value, session.id),
      ).toThrow(/immutable/);
    }
    expect(() => f.open({ huddleId: '../escape' })).toThrow();
    expect(
      createSessionRequestSchema.safeParse({ project_id: f.project.id, kind: 'huddle' }).success,
    ).toBe(false);
    expect(f.open().session).toEqual(session);
  });
  it('records huddle owners in the shared runtime inventory without terminal segments or provider identity', () => {
    const f = fixture();
    const { session } = f.open();
    const runtimes = new RuntimeStore(f.db);
    const input = {
      identity: {
        runtime_id: randomUUID(),
        incarnation: randomUUID(),
        launch_id: randomUUID(),
        profile_id: f.profile.id,
        project_id: f.project.id,
        session_id: session.id,
        canonical_worktree_path: f.home,
      },
      build: 'fixture',
      protocol: RUNTIME_PROTOCOL_VERSION,
      releasePath: f.home,
      huddle: { id: f.input.huddleId, capabilities: HUDDLE_RUNTIME_CAPABILITIES },
    };
    expect(() => runtimes.prepare({ ...input, huddle: undefined })).toThrow(/role/);
    const binding = runtimes.prepare(input);
    expect(binding).toMatchObject({
      role: 'huddle',
      huddle_id: f.input.huddleId,
      active_segment_id: null,
      account_id: null,
      agent_type: null,
      conversation_id: null,
      state: 'prepared',
    });
    expect(runtimes.prepare(input)).toEqual(binding);
    expect(runtimes.ownerOf(session.id)?.runtime_id).toBe(binding.runtime_id);
    expect(runtimes.hasUnreleasedWorktree(f.home)).toBe(true);
    expect(runtimes.releaseReferences()).toEqual([
      { runtime_id: binding.runtime_id, release_path: f.home },
    ]);
    expect(runtimes.usesExternalTerminals(session.id)).toBe(false);
    expect(f.db.prepare('SELECT * FROM runtime_segments').all()).toEqual([]);
    expect(() =>
      runtimes.prepare({ ...input, huddle: { ...input.huddle, id: 'b'.repeat(32) } }),
    ).toThrow(/different inputs/);
    f.reopen();
    expect(new RuntimeStore(f.db).live()).toEqual([binding]);
  });
});
