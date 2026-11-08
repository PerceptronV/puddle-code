import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono, type MiddlewareHandler } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { huddleOpenedSchema, runtimeReleaseCapabilities } from '@puddle/shared';
import { openDatabase } from '../../../src/db/db.js';
import { HuddlePlacements } from '../../../src/db/stores/huddle/placements.js';
import { ProfileStore } from '../../../src/db/stores/profiles.js';
import { ProjectStore } from '../../../src/db/stores/projects.js';
import { RepoStore } from '../../../src/db/stores/repos.js';
import { SessionStore } from '../../../src/db/stores/sessions.js';
import { WorktreeManager } from '../../../src/worktrees/manager.js';
import { KeyedMutex } from '../../../src/git/mutex.js';
import { resolvePaths } from '../../../src/paths.js';
import * as capture from '../../../src/huddle/definitions/capture.js';
import { HuddleService } from '../../../src/huddle/control/service.js';
import { resolveHuddleRuntimeRelease } from '../../../src/runtime/huddle/control/release.js';
import { huddleAuthoringRoutes } from '../../../src/http/routes/execution/huddle/authoring.js';
import { ApiError } from '../../../src/http/errors.js';
import { runtimeRelease } from '../../helpers/runtime-release.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-huddle-authoring-')));
  const worktree = join(home, 'project');
  mkdirSync(worktree);
  execFileSync('git', ['init', '-b', 'main', worktree], { stdio: 'ignore' });
  const db = openDatabase(join(home, 'db.sqlite'));
  cleanups.push(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const profiles = new ProfileStore(db);
  const projects = new ProjectStore(db);
  const repos = new RepoStore(db);
  const sessions = new SessionStore(db);
  const profile = profiles.create({ name: 'Huddles', branch_prefix: '' });
  const repo = repos.create({
    path: worktree,
    default_base_branch: 'main',
    onboarding_notes: null,
    fetch_enabled: false,
  });
  const project = projects.create({ profile_id: profile.id, repo_id: repo.id, name: 'Project' });
  const release = runtimeRelease(home, '1.2.3', '1.1');
  mkdirSync(join(release.release, 'daemon/huddle'));
  for (const name of ['runner.js', 'sdk.js'])
    writeFileSync(join(release.release, 'daemon/huddle', name), '// never execute');
  writeFileSync(
    join(release.release, 'RUNTIME_CAPABILITIES.json'),
    JSON.stringify(runtimeReleaseCapabilities('1.2.3')),
  );
  release.select();
  const changed = vi.fn();
  const storage = { assertAdmission: vi.fn(async (_paths: string[]) => {}) };
  const checkHuddleAvailable = vi.fn(async () => ({
    selected: resolveHuddleRuntimeRelease(home),
    lifetime: 'service' as const,
  }));
  const worktrees = new WorktreeManager({
    paths: resolvePaths(home),
    mutex: new KeyedMutex(),
    repos,
    sessions,
  });
  const placements = new HuddlePlacements(db);
  const service = new HuddleService({
    home,
    profiles,
    projects,
    repos,
    placements,
    worktrees,
    changed,
    storage,
    launcher: { checkHuddleAvailable },
  });
  const input = { project_id: project.id, worktree, name: 'Review' };
  let valid = true;
  const authority = () => valid;
  const create = () => service.create(profile.id, input, authority);
  const location = { project_id: project.id, worktree };
  return {
    home,
    worktree,
    db,
    profiles,
    profile,
    project,
    projects,
    placements,
    service,
    release,
    changed,
    storage,
    checkHuddleAvailable,
    input,
    location,
    authority,
    create,
    revoke: () => {
      valid = false;
    },
    unsupported: () => {
      rmSync(join(release.release, 'RUNTIME_CAPABILITIES.json'));
    },
  };
}

describe('inactive huddle authoring', () => {
  it('creates multiple random definitions and one stopped placement each without launching anything', async () => {
    const f = fixture();
    const first = huddleOpenedSchema.parse(await f.create());
    const second = await f.create();
    expect(first.session).toMatchObject({
      kind: 'huddle',
      status: 'exited',
      account_id: null,
      branch_owner: false,
      worktree_path: f.worktree,
    });
    expect(first.document.definition).toMatchObject({ name: 'Review', nodes: [], edges: [] });
    expect(first.session.huddle_id).toMatch(/^[a-f0-9]{32}$/);
    expect(second.session.huddle_id).not.toBe(first.session.huddle_id);
    const manifest = join(f.worktree, '.puddle/huddle', first.session.huddle_id!, 'huddle.json');
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toEqual(first.document.definition);
    const alias = join(f.home, 'alias');
    symlinkSync(f.worktree, alias);
    const opened = await Promise.all(
      Array.from({ length: 3 }, () =>
        f.service.open(
          f.profile.id,
          { ...f.location, worktree: alias, huddle_id: first.session.huddle_id! },
          f.authority,
        ),
      ),
    );
    expect(
      opened.every((result) => result.session.id === first.session.id && !result.created),
    ).toBe(true);
    expect(f.changed).toHaveBeenCalledTimes(2);
    expect(f.db.prepare('SELECT * FROM runtime_bindings').all()).toEqual([]);
    expect(f.db.prepare('SELECT * FROM terminal_placements').all()).toEqual([]);
    expect(await f.service.discover(f.profile.id, f.location, f.authority)).toHaveLength(2);
    expect(first.document).not.toHaveProperty('files');
  });

  it('requires capable runtime metadata before writes but permits existing placement inspection after default changes', async () => {
    const f = fixture();
    f.unsupported();
    expect(await f.service.availability(f.profile.id, f.authority)).toMatchObject({
      available: false,
    });
    await expect(f.create()).rejects.toMatchObject({ code: 'huddle_runtime_unavailable' });
    expect(existsSync(join(f.worktree, '.puddle'))).toBe(false);
    writeFileSync(
      join(f.release.release, 'RUNTIME_CAPABILITIES.json'),
      JSON.stringify(runtimeReleaseCapabilities('1.2.3')),
    );
    const first = await f.create();
    f.unsupported();
    const input = { ...f.location, huddle_id: first.session.huddle_id! };
    expect((await f.service.open(f.profile.id, input, f.authority)).session.id).toBe(
      first.session.id,
    );
    expect((await f.service.inspect(f.profile.id, input, f.authority)).digest).toBe(
      first.document.digest,
    );
    const other = f.projects.create({
      profile_id: f.profile.id,
      repo_id: f.project.repo_id,
      name: 'Other',
    });
    await expect(
      f.service.open(f.profile.id, { ...input, project_id: other.id }, f.authority),
    ).rejects.toMatchObject({ code: 'huddle_runtime_unavailable' });
  });

  it.each(['revoke', 'archive', 'selection', 'storage'] as const)(
    'rejects %s changes after async admission before creating source',
    async (mode) => {
      const f = fixture();
      f.storage.assertAdmission.mockImplementationOnce(async () => {
        if (mode === 'revoke') f.revoke();
        if (mode === 'archive') f.projects.setArchived(f.project.id, true);
        if (mode === 'selection') runtimeRelease(f.home, '2.0.0', '1.1').select();
        if (mode === 'storage') throw new Error('Storage full');
      });
      await expect(f.create()).rejects.toThrow();
      expect(existsSync(join(f.worktree, '.puddle'))).toBe(false);
      expect(f.db.prepare('SELECT * FROM sessions').all()).toEqual([]);
    },
  );

  it('rejects cross-profile and unregistered/subdirectory roots and symlinked collections', async () => {
    const f = fixture();
    const other = f.profiles.create({ name: 'Other', branch_prefix: '' });
    await expect(f.service.create(other.id, f.input, f.authority)).rejects.toMatchObject({
      code: 'profile_scope',
    });
    const child = join(f.worktree, 'nested');
    mkdirSync(child);
    for (const root of [child, f.home, '.', join(f.home, 'missing')]) {
      await expect(
        f.service.create(f.profile.id, { ...f.input, worktree: root }, f.authority),
      ).rejects.toThrow();
    }
    const outside = join(f.home, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(f.worktree, '.puddle'));
    await expect(f.create()).rejects.toThrow(/ordinary directories/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('retains published source after lost placement admission so discovery/open can recover it', async () => {
    const f = fixture();
    const open = vi.spyOn(f.placements, 'open').mockImplementationOnce(() => {
      throw new Error('placement write failed');
    });
    await expect(f.create()).rejects.toThrow('placement write failed');
    expect(f.db.prepare('SELECT * FROM sessions').all()).toEqual([]);
    open.mockRestore();
    const discovered = await f.service.discover(f.profile.id, f.location, f.authority);
    expect(discovered).toHaveLength(1);
    const recovered = await f.service.open(
      f.profile.id,
      { ...f.location, huddle_id: discovered[0]!.id },
      f.authority,
    );
    expect(recovered.created).toBe(true);
    expect(recovered.session.status).toBe('exited');
    expect(f.db.prepare('SELECT * FROM runtime_bindings').all()).toEqual([]);
  });

  it('rechecks authority after source capture before creating a placement', async () => {
    const f = fixture();
    const original = capture.captureHuddleDefinition;
    vi.spyOn(capture, 'captureHuddleDefinition').mockImplementationOnce(async (...args) => {
      const snapshot = await original(...args);
      f.revoke();
      return snapshot;
    });
    await expect(f.create()).rejects.toMatchObject({ code: 'upstream_expired' });
    expect(f.db.prepare('SELECT * FROM sessions').all()).toEqual([]);
    expect(readdirSync(join(f.worktree, '.puddle/huddle'))).toHaveLength(1);
    expect(f.changed).not.toHaveBeenCalled();
  });

  it('exposes strict local authoring routes and refuses remote or revoked authority', async () => {
    const f = fixture();
    let remote = false;
    const authority: MiddlewareHandler = async (c, next) => {
      c.set('authorityValid', f.authority);
      c.set('remoteProfile', remote ? f.profile.id : undefined);
      await next();
    };
    const app = new Hono()
      .use('*', authority)
      .route('/api/huddle', huddleAuthoringRoutes(f.service));
    app.onError((error, c) =>
      c.json(
        { code: error instanceof ApiError ? error.code : 'internal' },
        error instanceof ApiError ? (error.status as 400) : 500,
      ),
    );
    const path = `/api/huddle/${f.profile.id}`;
    const post = (body: unknown) =>
      app.request(`${path}/definitions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({ ...f.input, host_id: 'untrusted' })).status).toBe(400);
    const response = await post(f.input);
    expect(response.status).toBe(201);
    const opened = huddleOpenedSchema.parse(await response.json());
    const query = new URLSearchParams(f.location);
    expect((await app.request(`${path}/definitions?${query}`)).status).toBe(200);
    expect(
      (await app.request(`${path}/definitions/${opened.session.huddle_id}?${query}`)).status,
    ).toBe(200);
    remote = true;
    expect((await post(f.input)).status).toBe(403);
    expect((await app.request(`${path}/availability`)).status).toBe(403);
    remote = false;
    f.revoke();
    expect((await post(f.input)).status).toBe(401);
    expect(f.db.prepare('SELECT * FROM sessions').all()).toHaveLength(1);
  });
});
