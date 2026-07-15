import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fsOpResponseSchema, gitStatusResponseSchema } from '@puddle/shared';
import { worktreeRoutes } from '../src/http/routes/worktrees.js';
import { ApiError } from '../src/http/errors.js';
import { fixture, waitFor, type Fixture } from './helpers/daemon-fixtures.js';

let fx: Fixture;
let sessionId: string;
let worktree: string;
let app: Hono;

beforeAll(async () => {
  fx = fixture();
  const session = await fx.service.create({
    project_id: fx.ids.project,
    account_id: fx.ids.account,
    title: 'fs-ops target',
  });
  sessionId = session.id;
  await waitFor(() => fx.service.get(sessionId).status !== 'starting');
  worktree = fx.service.get(sessionId).worktree_path;

  app = new Hono();
  app.onError((err, c) =>
    err instanceof ApiError
      ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400)
      : c.json({ error: { code: 'internal', message: String(err) } }, 500),
  );
  app.route('/api/worktrees', worktreeRoutes({ sessions: fx.stores.sessions }));
});

afterAll(async () => {
  await fx.service.kill(sessionId).catch(() => undefined);
});

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

function post(sid: string, op: string, body: unknown) {
  return app.request(`/api/worktrees/${sid}/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /:sid/create', () => {
  it('creates an empty file, making parents as needed', async () => {
    const res = await post(sessionId, 'create', { path: 'nested/dir/hello.txt', kind: 'file' });
    expect(res.status).toBe(201);
    const body = fsOpResponseSchema.parse(await res.json());
    expect(body.path).toBe('nested/dir/hello.txt');
    expect(readFileSync(join(worktree, 'nested/dir/hello.txt'), 'utf8')).toBe('');
  });

  it('creates a folder', async () => {
    const res = await post(sessionId, 'create', { path: 'newdir', kind: 'dir' });
    expect(res.status).toBe(201);
    expect(statSync(join(worktree, 'newdir')).isDirectory()).toBe(true);
  });

  it('409s when the path already exists', async () => {
    writeFileSync(join(worktree, 'taken.txt'), 'x');
    const res = await post(sessionId, 'create', { path: 'taken.txt', kind: 'file' });
    expect(res.status).toBe(409);
    expect(errorCode(await res.json())).toBe('already_exists');
  });

  it('rejects an escape attempt', async () => {
    const res = await post(sessionId, 'create', { path: '../escape.txt', kind: 'file' });
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('path_outside_worktree');
    expect(existsSync(join(worktree, '..', 'escape.txt'))).toBe(false);
  });
});

describe('POST /:sid/rename', () => {
  it('moves a file to a new path', async () => {
    writeFileSync(join(worktree, 'from.txt'), 'move me\n');
    mkdirSync(join(worktree, 'dest'), { recursive: true });
    const res = await post(sessionId, 'rename', { from: 'from.txt', to: 'dest/to.txt' });
    expect(res.status).toBe(200);
    const body = fsOpResponseSchema.parse(await res.json());
    expect(body.path).toBe('dest/to.txt');
    expect(existsSync(join(worktree, 'from.txt'))).toBe(false);
    expect(readFileSync(join(worktree, 'dest/to.txt'), 'utf8')).toBe('move me\n');
  });

  it('404s when the source is missing', async () => {
    const res = await post(sessionId, 'rename', { from: 'ghost.txt', to: 'x.txt' });
    expect(res.status).toBe(404);
  });

  it('409s when the destination exists', async () => {
    writeFileSync(join(worktree, 'a.txt'), 'a');
    writeFileSync(join(worktree, 'b.txt'), 'b');
    const res = await post(sessionId, 'rename', { from: 'a.txt', to: 'b.txt' });
    expect(res.status).toBe(409);
    expect(errorCode(await res.json())).toBe('already_exists');
  });

  it('rejects an escaping destination', async () => {
    writeFileSync(join(worktree, 'src.txt'), 'x');
    const res = await post(sessionId, 'rename', { from: 'src.txt', to: '../out.txt' });
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('path_outside_worktree');
  });
});

describe('POST /:sid/copy', () => {
  it('copies a file with identical content', async () => {
    writeFileSync(join(worktree, 'orig.txt'), 'clone me\n');
    const res = await post(sessionId, 'copy', { from: 'orig.txt', to: 'dupe.txt' });
    expect(res.status).toBe(201);
    const body = fsOpResponseSchema.parse(await res.json());
    expect(body.path).toBe('dupe.txt');
    expect(readFileSync(join(worktree, 'dupe.txt'), 'utf8')).toBe('clone me\n');
  });

  it('auto-suffixes " copy" when the destination collides', async () => {
    writeFileSync(join(worktree, 'doc.md'), 'v1\n');
    // Paste into the same folder: to === from, so the name is taken.
    const res = await post(sessionId, 'copy', { from: 'doc.md', to: 'doc.md' });
    expect(res.status).toBe(201);
    const body = fsOpResponseSchema.parse(await res.json());
    expect(body.path).toBe('doc copy.md');
    expect(readFileSync(join(worktree, 'doc copy.md'), 'utf8')).toBe('v1\n');
  });

  it('copies a directory recursively', async () => {
    mkdirSync(join(worktree, 'folder/sub'), { recursive: true });
    writeFileSync(join(worktree, 'folder/sub/leaf.txt'), 'deep\n');
    const res = await post(sessionId, 'copy', { from: 'folder', to: 'folder-copy' });
    expect(res.status).toBe(201);
    expect(readFileSync(join(worktree, 'folder-copy/sub/leaf.txt'), 'utf8')).toBe('deep\n');
  });

  it('404s when the source is missing', async () => {
    const res = await post(sessionId, 'copy', { from: 'nope.txt', to: 'x.txt' });
    expect(res.status).toBe(404);
  });
});

describe('POST /:sid/delete', () => {
  it('removes a file', async () => {
    writeFileSync(join(worktree, 'trash.txt'), 'bye');
    const res = await post(sessionId, 'delete', { path: 'trash.txt' });
    expect(res.status).toBe(200);
    expect(existsSync(join(worktree, 'trash.txt'))).toBe(false);
  });

  it('removes a directory recursively', async () => {
    mkdirSync(join(worktree, 'doomed/inner'), { recursive: true });
    writeFileSync(join(worktree, 'doomed/inner/f.txt'), 'x');
    const res = await post(sessionId, 'delete', { path: 'doomed' });
    expect(res.status).toBe(200);
    expect(existsSync(join(worktree, 'doomed'))).toBe(false);
  });

  it('404s a missing path', async () => {
    const res = await post(sessionId, 'delete', { path: 'never-existed' });
    expect(res.status).toBe(404);
  });

  it('rejects an escape attempt', async () => {
    const res = await post(sessionId, 'delete', { path: '../../etc' });
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('path_outside_worktree');
  });
});

describe('GET /:sid/git-status', () => {
  it('reports untracked and ignored files distinctly', async () => {
    writeFileSync(join(worktree, 'brand-new.txt'), 'hello\n');
    writeFileSync(join(worktree, '.gitignore'), 'ignored-here.log\n');
    writeFileSync(join(worktree, 'ignored-here.log'), 'noise\n');

    const res = await app.request(`/api/worktrees/${sessionId}/git-status`);
    expect(res.status).toBe(200);
    const body = gitStatusResponseSchema.parse(await res.json());
    const byPath = new Map(body.entries.map((e) => [e.path, e.status]));
    expect(byPath.get('brand-new.txt')).toBe('untracked');
    expect(byPath.get('ignored-here.log')).toBe('ignored');
  });
});
