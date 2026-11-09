import { join } from 'node:path';
import { HuddleOfflineReadouts } from '../../../src/huddle/execution/readouts/offline.js';
import { execFileSync } from 'node:child_process';
import { Hono } from 'hono';
import { vi } from 'vitest';
import { HuddleService } from '../../../src/huddle/control/service.js';
import { HuddleExecutionService } from '../../../src/huddle/execution/service.js';
import { HuddlePlacements } from '../../../src/db/stores/huddle/placements.js';
import { RepoStore } from '../../../src/db/stores/repos.js';
import { ProjectStore } from '../../../src/db/stores/projects.js';
import { WorktreeManager } from '../../../src/worktrees/manager.js';
import { KeyedMutex } from '../../../src/git/mutex.js';
import { huddleAuthoringRoutes } from '../../../src/http/routes/execution/huddle/authoring.js';
import { huddleExecutionRoutes } from '../../../src/http/routes/execution/huddle/execution.js';
import { ApiError } from '../../../src/http/errors.js';
import { huddleLaunchFixture } from './launch.js';

export async function huddleExecutionFixture(native?: 'interactive', nativeSupervisor = false) {
  const f = await huddleLaunchFixture(false, native, nativeSupervisor);
  execFileSync('git', ['init', '-b', 'main', f.home], { stdio: 'ignore' });
  const repos = new RepoStore(f.db);
  const projects = new ProjectStore(f.db);
  const worktrees = new WorktreeManager({
    paths: f.paths,
    mutex: new KeyedMutex(),
    repos,
    sessions: f.sessions,
  });
  const storage = { assertAdmission: vi.fn(async (_paths: string[]) => {}) };
  const definitions = new HuddleService({
    ...f,
    repos,
    projects,
    worktrees,
    storage,
    placements: new HuddlePlacements(f.db),
    launcher: f.launcher,
    changed: () => {},
  });
  const offlineReadouts = new HuddleOfflineReadouts(
    f.home,
    join(f.installed.release, 'daemon/huddle/runner.js'),
  );
  const execution = new HuddleExecutionService({
    offlineReadouts,
    ...f,
    definitions,
    projects,
    storage,
    controls: f.controls.huddles,
  });
  let valid = true;
  let remote: string | undefined;
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ApiError)
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    return c.json({ error: { code: 'internal', message: String(error) } }, 500);
  });
  app.use('*', async (c, next) => {
    c.set('authorityValid', () => valid);
    c.set('remoteProfile', remote);
    await next();
  });
  app.route('/api/huddle', huddleAuthoringRoutes(definitions));
  app.route('/api/huddle', huddleExecutionRoutes(execution));
  const path = (action: string, profile = f.profile.id, sid = f.session.id) =>
    `/api/huddle/${profile}/sessions/${sid}/${action}`;
  const request = async (action: string, body?: unknown, profile?: string, sid?: string) => {
    const response = await app.request(path(action, profile, sid), {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const source = () =>
    definitions.inspect(
      f.profile.id,
      { project_id: f.project.id, worktree: f.home, huddle_id: f.session.huddle_id! },
      () => valid,
    );
  return {
    ...f,
    offlineReadouts,
    async close() {
      await offlineReadouts.close();
      await f.close();
    },
    app,
    projects,
    definitions,
    execution,
    source,
    request,
    storage,
    revoke: () => {
      valid = false;
    },
    remote: () => {
      remote = f.profile.id;
    },
  };
}
