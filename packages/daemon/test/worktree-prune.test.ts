import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RepoWorktreesResponse } from '@puddle/shared';
import { repoRoutes } from '../src/http/routes/repos.js';
import { ApiError } from '../src/http/errors.js';
import { fixture, waitFor, type Fixture } from './helpers/daemon-fixtures.js';

/** Worktree manager pruning (SPEC §8): guards against clone/dirty/live/unpushed. */

let fx: Fixture;
let app: Hono;
const sessionIds: string[] = [];

beforeAll(() => {
  fx = fixture();
  app = new Hono();
  app.onError((err, c) =>
    err instanceof ApiError
      ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400)
      : c.json({ error: { code: 'internal', message: String(err) } }, 500),
  );
  app.route(
    '/api/repos',
    repoRoutes({ repos: fx.stores.repos, sessions: fx.stores.sessions, worktrees: fx.worktrees }),
  );
});

afterAll(async () => {
  for (const id of sessionIds) await fx.service.kill(id).catch(() => undefined);
});

async function newSession(branch: string): Promise<{ id: string; worktree: string }> {
  const s = await fx.service.create({
    project_id: fx.ids.project,
    account_id: fx.ids.account,
    branch,
  });
  sessionIds.push(s.id);
  await waitFor(() => fx.service.get(s.id).status !== 'starting');
  return { id: s.id, worktree: s.worktree_path };
}

function list() {
  return app.request(`/api/repos/${fx.ids.repo}/worktrees`);
}
function prune(path: string, confirm = false) {
  const qs = new URLSearchParams({ path });
  if (confirm) qs.set('confirm', '1');
  return app.request(`/api/repos/${fx.ids.repo}/worktrees?${qs.toString()}`, { method: 'DELETE' });
}
function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

describe('GET /api/repos/:id/worktrees', () => {
  it('lists the clone as the primary worktree with dirty/local_only status', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    const body = (await res.json()) as RepoWorktreesResponse;
    const primary = body.worktrees.find((w) => w.is_primary);
    expect(primary?.path).toBe(fx.repoPath);
    expect(primary?.branch).toBe('main');
    // The fixture repo has no remote, so all its history is local-only.
    expect(primary?.local_only).toBe(true);
    expect(typeof primary?.dirty).toBe('boolean');
  });
});

describe('DELETE /api/repos/:id/worktrees (prune)', () => {
  it('refuses to prune the repository clone', async () => {
    const res = await prune(fx.repoPath, true);
    expect(res.status).toBe(409);
    expect(errorCode(await res.json())).toBe('worktree_primary');
  });

  it('404s an unknown path', async () => {
    const res = await prune('/no/such/worktree', true);
    expect(res.status).toBe(404);
  });

  it('refuses while a session is live, then allows once it is not', async () => {
    const { id, worktree } = await newSession('feat/live');
    // Fresh session is starting/running → live → blocked.
    const busy = await prune(worktree, true);
    expect(busy.status).toBe(409);
    expect(errorCode(await busy.json())).toBe('worktree_busy');

    await fx.service.kill(id); // now exited — not live
    const ok = await prune(worktree, true);
    expect(ok.status).toBe(200);
    expect(existsSync(worktree)).toBe(false);
  });

  it('refuses to prune a dirty worktree', async () => {
    const { id, worktree } = await newSession('feat/dirty');
    await fx.service.kill(id);
    writeFileSync(join(worktree, 'README.md'), '# changed\n'); // modify a tracked file
    const res = await prune(worktree, true);
    expect(res.status).toBe(409);
    expect(errorCode(await res.json())).toBe('worktree_dirty');
  });

  it('requires confirmation for a purely-local branch', async () => {
    const { id, worktree } = await newSession('feat/unpushed');
    await fx.service.kill(id);
    const noConfirm = await prune(worktree, false);
    expect(noConfirm.status).toBe(409);
    expect(errorCode(await noConfirm.json())).toBe('worktree_unpushed');

    const confirmed = await prune(worktree, true);
    expect(confirmed.status).toBe(200);
    expect(existsSync(worktree)).toBe(false);
    // Pruning keeps the branch (only the worktree goes).
    const body = (await confirmed.json()) as RepoWorktreesResponse;
    expect(body.worktrees.some((w) => w.path === worktree)).toBe(false);
  });
});
