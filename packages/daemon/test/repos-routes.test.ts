import { rmSync } from 'node:fs';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoSchema, type Repo } from '@puddle/shared';
import { repoRoutes } from '../src/http/routes/repos.js';
import { fixture, type Fixture } from './helpers/daemon-fixtures.js';
import { cloneRepo, initRepo, sh } from './helpers/git-fixtures.js';

let fx: Fixture;
let app: Hono;
const cleanup: string[] = [];

beforeAll(() => {
  fx = fixture();
  app = new Hono();
  app.route(
    '/api/repos',
    repoRoutes({ repos: fx.stores.repos, sessions: fx.stores.sessions, worktrees: fx.worktrees }),
  );
});

afterAll(() => {
  for (const path of cleanup) rmSync(path, { recursive: true, force: true });
});

async function register(path: string, defaultBaseBranch?: string): Promise<Repo> {
  const response = await app.request('/api/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path,
      ...(defaultBaseBranch === undefined ? {} : { default_base_branch: defaultBaseBranch }),
    }),
  });
  expect(response.status).toBe(201);
  return repoSchema.parse(await response.json());
}

describe('POST /api/repos default base branch', () => {
  it('inherits the branch checked out by the clone', async () => {
    const source = initRepo();
    sh(source, 'checkout', '-b', 'develop');
    const clone = cloneRepo(source);
    cleanup.push(source, clone);

    expect((await register(clone)).default_base_branch).toBe('develop');
  });

  it('honours an explicit base branch', async () => {
    const repo = initRepo();
    sh(repo, 'checkout', '-b', 'develop');
    cleanup.push(repo);

    expect((await register(repo, 'main')).default_base_branch).toBe('main');
  });

  it('falls back to main when HEAD is detached', async () => {
    const repo = initRepo();
    sh(repo, 'checkout', '--detach');
    cleanup.push(repo);

    expect((await register(repo)).default_base_branch).toBe('main');
  });
});
