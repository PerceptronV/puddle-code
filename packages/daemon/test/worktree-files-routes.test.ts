import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as yauzl from 'yauzl';
import {
  fileResponseSchema,
  putFileResponseSchema,
  treeResponseSchema,
  uploadResponseSchema,
} from '@puddle/shared';
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
    title: 'file explorer target',
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
  await fx.service.kill(sessionId).catch(() => undefined); // reap the fake agent's PTY
});

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

function tree(sid: string, path?: string) {
  const qs = path === undefined ? '' : `?path=${encodeURIComponent(path)}`;
  return app.request(`/api/worktrees/${sid}/tree${qs}`);
}

function getFile(sid: string, path: string) {
  return app.request(`/api/worktrees/${sid}/file?path=${encodeURIComponent(path)}`);
}

function putFile(sid: string, path: string, body: unknown) {
  return app.request(`/api/worktrees/${sid}/file?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function download(sid: string, path: string) {
  return app.request(`/api/worktrees/${sid}/download?path=${encodeURIComponent(path)}`);
}

function upload(sid: string, dir: string, form: FormData) {
  return app.request(`/api/worktrees/${sid}/upload?dir=${encodeURIComponent(dir)}`, {
    method: 'POST',
    body: form,
  });
}

describe('GET /api/worktrees/:sid/tree', () => {
  beforeAll(() => {
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'index.ts'), 'export {};\n');
    writeFileSync(join(worktree, 'README.md'), '# demo\n');
    writeFileSync(join(worktree, 'apple.txt'), 'a\n');
  });

  it('lists the root sorted dirs-first, case-insensitive, and hides .git', async () => {
    const res = await tree(sessionId);
    expect(res.status).toBe(200);
    const body = treeResponseSchema.parse(await res.json());
    expect(body.path).toBe('');
    const names = body.entries.map((e) => e.name);
    expect(names).not.toContain('.git');
    expect(names).toContain('src');
    expect(names).toContain('README.md');
    expect(names).toContain('apple.txt');
    const srcEntry = body.entries.find((e) => e.name === 'src');
    expect(srcEntry).toMatchObject({ type: 'dir', size: null });
    // dirs-first
    const firstFileIdx = body.entries.findIndex((e) => e.type !== 'dir');
    const lastDirIdx = body.entries.map((e) => e.type).lastIndexOf('dir');
    expect(lastDirIdx).toBeLessThan(firstFileIdx === -1 ? Infinity : firstFileIdx);
    // case-insensitive alpha among files: README.md before apple.txt would fail
    // case-sensitive sort ('R' < 'a'); case-insensitive puts apple before README.
    const fileNames = body.entries.filter((e) => e.type === 'file').map((e) => e.name);
    expect(fileNames.indexOf('apple.txt')).toBeLessThan(fileNames.indexOf('README.md'));
  });

  it('lists a nested path', async () => {
    const res = await tree(sessionId, 'src');
    const body = treeResponseSchema.parse(await res.json());
    expect(body.entries.map((e) => e.name)).toEqual(['index.ts']);
  });

  it('reports symlinks distinctly with a null size', async () => {
    symlinkSync(join(worktree, 'apple.txt'), join(worktree, 'link-to-apple'));
    const res = await tree(sessionId);
    const body = treeResponseSchema.parse(await res.json());
    const link = body.entries.find((e) => e.name === 'link-to-apple');
    expect(link).toMatchObject({ type: 'symlink', size: null });
  });

  it('rejects a relative traversal', async () => {
    const res = await tree(sessionId, '../..');
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('path_outside_worktree');
  });

  it('rejects an absolute path', async () => {
    const res = await tree(sessionId, '/etc');
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('path_outside_worktree');
  });

  it('rejects a URL-encoded traversal', async () => {
    const res = await app.request(`/api/worktrees/${sessionId}/tree?path=..%2f..%2f`);
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('path_outside_worktree');
  });

  it('400s when the path is a file, not a directory', async () => {
    const res = await tree(sessionId, 'apple.txt');
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('not_a_directory');
  });

  it('404s an unknown session', async () => {
    const res = await tree('no-such-session');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/worktrees/:sid/file', () => {
  it('round-trips content and mtime_ms', async () => {
    writeFileSync(join(worktree, 'hello.txt'), 'hello world\n');
    const res = await getFile(sessionId, 'hello.txt');
    expect(res.status).toBe(200);
    const body = fileResponseSchema.parse(await res.json());
    expect(body.content).toBe('hello world\n');
    expect(body.binary).toBe(false);
    expect(body.size).toBe(12);
    expect(typeof body.mtime_ms).toBe('number');
  });

  it('404s a missing file', async () => {
    const res = await getFile(sessionId, 'does-not-exist.txt');
    expect(res.status).toBe(404);
    expect(errorCode(await res.json())).toBe('not_found');
  });

  it('400s a directory path', async () => {
    const res = await getFile(sessionId, 'src');
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('not_a_file');
  });

  it('detects a NUL byte within the first 8 KiB as binary', async () => {
    const bytes = Buffer.concat([Buffer.from('lead-in'), Buffer.from([0x00]), Buffer.from('tail')]);
    writeFileSync(join(worktree, 'binary.bin'), bytes);
    const res = await getFile(sessionId, 'binary.bin');
    const body = fileResponseSchema.parse(await res.json());
    expect(body.binary).toBe(true);
    expect(body.content).toBeNull();
    expect(body.size).toBe(bytes.byteLength);
  });

  it('413s a file above the 5 MiB cap', async () => {
    writeFileSync(join(worktree, 'huge.bin'), Buffer.alloc(5 * 1024 * 1024 + 1));
    const res = await getFile(sessionId, 'huge.bin');
    expect(res.status).toBe(413);
    expect(errorCode(await res.json())).toBe('file_too_large');
  });
});

describe('PUT /api/worktrees/:sid/file', () => {
  it('writes content visible via a direct readFileSync', async () => {
    const res = await putFile(sessionId, 'edited.txt', { content: 'v1\n' });
    expect(res.status).toBe(200);
    const body = putFileResponseSchema.parse(await res.json());
    expect(readFileSync(join(worktree, 'edited.txt'), 'utf8')).toBe('v1\n');
    expect(body.size).toBe(3);
  });

  it('creates a new file', async () => {
    const res = await putFile(sessionId, 'brand-new.txt', { content: 'fresh\n' });
    expect(res.status).toBe(200);
    expect(readFileSync(join(worktree, 'brand-new.txt'), 'utf8')).toBe('fresh\n');
  });

  it('409s on a stale expected_mtime_ms', async () => {
    const first = putFileResponseSchema.parse(
      await (await putFile(sessionId, 'concurrent.txt', { content: 'v1\n' })).json(),
    );
    // Simulate another writer changing the file after the editor loaded it.
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(join(worktree, 'concurrent.txt'), 'someone-else\n');

    const res = await putFile(sessionId, 'concurrent.txt', {
      content: 'my-edit\n',
      expected_mtime_ms: first.mtime_ms,
    });
    expect(res.status).toBe(409);
    expect(errorCode(await res.json())).toBe('stale_file');
    expect(readFileSync(join(worktree, 'concurrent.txt'), 'utf8')).toBe('someone-else\n');
  });

  it('an unconditional PUT succeeds after the stale rejection ("Overwrite anyway")', async () => {
    const res = await putFile(sessionId, 'concurrent.txt', { content: 'overwritten\n' });
    expect(res.status).toBe(200);
    expect(readFileSync(join(worktree, 'concurrent.txt'), 'utf8')).toBe('overwritten\n');
  });

  it('400s when the parent directory does not exist', async () => {
    const res = await putFile(sessionId, 'no-such-dir/file.txt', { content: 'x\n' });
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('not_a_directory');
  });
});

describe('POST /api/worktrees/:sid/upload', () => {
  it('lands two multipart files in dir=, neutralising any path in the filename', async () => {
    mkdirSync(join(worktree, 'uploads'), { recursive: true });
    const form = new FormData();
    form.set('a', new File(['one'], 'one.txt'));
    form.set('b', new File(['two-longer'], '../../evil.txt'));

    const res = await upload(sessionId, 'uploads', form);
    expect(res.status).toBe(201);
    const body = uploadResponseSchema.parse(await res.json());
    expect(body.files).toHaveLength(2);

    expect(readFileSync(join(worktree, 'uploads', 'one.txt'), 'utf8')).toBe('one');
    expect(readFileSync(join(worktree, 'uploads', 'evil.txt'), 'utf8')).toBe('two-longer');
    expect(existsSync(join(worktree, 'evil.txt'))).toBe(false);
  });

  it('400s when dir does not exist', async () => {
    const form = new FormData();
    form.set('a', new File(['x'], 'x.txt'));
    const res = await upload(sessionId, 'missing-dir', form);
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('not_a_directory');
  });

  it('400s nothing_uploaded when the form has no files', async () => {
    const form = new FormData();
    form.set('note', 'not a file');
    const res = await upload(sessionId, 'uploads', form);
    expect(res.status).toBe(400);
    expect(errorCode(await res.json())).toBe('nothing_uploaded');
  });

  it('413s an oversize content-length header without writing a body', async () => {
    const res = await app.request(`/api/worktrees/${sessionId}/upload?dir=uploads`, {
      method: 'POST',
      headers: {
        'content-length': String(101 * 1024 * 1024),
        'content-type': 'multipart/form-data',
      },
      body: new Uint8Array(0),
    });
    expect(res.status).toBe(413);
    expect(errorCode(await res.json())).toBe('upload_too_large');
  });
});

describe('GET /api/worktrees/:sid/download', () => {
  it('streams identical bytes for a single file', async () => {
    const original = readFileSync(join(worktree, 'apple.txt'));
    const res = await download(sessionId, 'apple.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain(`filename*=UTF-8''apple.txt`);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes).toEqual(original);
  });

  it('zips a directory, excluding .git, with the right entries and content-disposition', async () => {
    const res = await download(sessionId, 'src');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain(`filename*=UTF-8''src.zip`);

    const zipBytes = Buffer.from(await res.arrayBuffer());
    const entries = await new Promise<string[]>((resolvePromise, reject) => {
      yauzl.fromBuffer(zipBytes, { lazyEntries: true }, (err, zipfile) => {
        if (err || !zipfile) return reject(err);
        const names: string[] = [];
        zipfile.on('entry', (entry) => {
          names.push(entry.fileName);
          zipfile.readEntry();
        });
        zipfile.on('end', () => resolvePromise(names));
        zipfile.on('error', reject);
        zipfile.readEntry();
      });
    });
    expect(entries).toContain('index.ts');
    expect(entries.some((n) => n.includes('.git'))).toBe(false);
  });
});

describe('worktree-files: shared error conditions', () => {
  it('404s an unknown session on every endpoint', async () => {
    const uploadForm = new FormData();
    uploadForm.set('a', new File(['x'], 'x.txt'));

    expect((await tree('no-such-session')).status).toBe(404);
    expect((await getFile('no-such-session', 'apple.txt')).status).toBe(404);
    expect((await putFile('no-such-session', 'apple.txt', { content: 'x' })).status).toBe(404);
    expect((await upload('no-such-session', 'uploads', uploadForm)).status).toBe(404);
    expect((await download('no-such-session', 'apple.txt')).status).toBe(404);
  });

  it('409s every endpoint once the worktree is gone from disk', async () => {
    const uploadForm = new FormData();
    uploadForm.set('a', new File(['x'], 'x.txt'));
    rmSync(worktree, { recursive: true, force: true });
    expect(existsSync(worktree)).toBe(false);

    expect((await tree(sessionId)).status).toBe(409);
    expect((await getFile(sessionId, 'apple.txt')).status).toBe(409);
    expect((await putFile(sessionId, 'apple.txt', { content: 'x' })).status).toBe(409);
    expect((await upload(sessionId, 'uploads', uploadForm)).status).toBe(409);
    expect((await download(sessionId, 'apple.txt')).status).toBe(409);
  });
});
