import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { Hono } from 'hono';
import {
  copyEntryRequestSchema,
  createEntryRequestSchema,
  deleteEntryRequestSchema,
  renameEntryRequestSchema,
  type FsOpResponse,
} from '@puddle/shared';
import type { SessionStore } from '../../db/stores/sessions.js';
import { ApiError } from '../errors.js';
import { parseBody } from '../validate.js';
import { containedPath, resolveWorktree } from './worktree-shared.js';

/**
 * The worktree's on-disk mutations from the file explorer (SPEC §8): create,
 * rename/move, copy, delete. Every path argument is run through
 * `containedPath` (worktree-shared.ts) — the same escape-the-worktree guard the
 * read/upload/download routes use — before it touches the filesystem. Mounted
 * by `worktrees.ts`. Deliberately separate from the read-only `worktree-git.ts`
 * and browsing `worktree-files.ts`: these are the only client-driven writes.
 */

/**
 * A non-colliding sibling of `abs`, inserting ` copy`, ` copy 2`, … before the
 * extension (VSCode's paste-into-same-folder behaviour): `foo.txt` → `foo copy.txt`,
 * a folder `bar` → `bar copy`. Returns `abs` unchanged when nothing exists there.
 */
function uniqueDestination(abs: string): string {
  if (!existsSync(abs)) return abs;
  const dir = dirname(abs);
  const ext = extname(abs);
  const stem = abs.slice(dir.length + 1, abs.length - ext.length);
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' copy' : ` copy ${n}`;
    const candidate = join(dir, `${stem}${suffix}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}

export function worktreeFsOpsRoutes(deps: { sessions: SessionStore }): Hono {
  return new Hono()
    .post('/:sid/create', async (c) => {
      const { root } = resolveWorktree(deps.sessions, c);
      const body = await parseBody(c, createEntryRequestSchema);
      const target = containedPath(root, body.path);
      if (existsSync(target)) {
        throw ApiError.conflict('already_exists', `${body.path} already exists`);
      }
      if (body.kind === 'dir') {
        mkdirSync(target, { recursive: true });
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, '');
      }
      return c.json<FsOpResponse>({ ok: true, path: relative(root, target) }, 201);
    })

    .post('/:sid/rename', async (c) => {
      const { root } = resolveWorktree(deps.sessions, c);
      const body = await parseBody(c, renameEntryRequestSchema);
      const from = containedPath(root, body.from);
      const to = containedPath(root, body.to);
      if (!existsSync(from)) throw ApiError.notFound('path', body.from);
      if (existsSync(to)) {
        throw ApiError.conflict('already_exists', `${body.to} already exists`);
      }
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      return c.json<FsOpResponse>({ ok: true, path: relative(root, to) });
    })

    .post('/:sid/copy', async (c) => {
      const { root } = resolveWorktree(deps.sessions, c);
      const body = await parseBody(c, copyEntryRequestSchema);
      const from = containedPath(root, body.from);
      const requestedTo = containedPath(root, body.to);
      if (!existsSync(from)) throw ApiError.notFound('path', body.from);
      mkdirSync(dirname(requestedTo), { recursive: true });
      const to = uniqueDestination(requestedTo);
      cpSync(from, to, { recursive: true });
      return c.json<FsOpResponse>({ ok: true, path: relative(root, to) }, 201);
    })

    .post('/:sid/delete', async (c) => {
      const { root } = resolveWorktree(deps.sessions, c);
      const body = await parseBody(c, deleteEntryRequestSchema);
      const target = containedPath(root, body.path);
      if (!existsSync(target)) throw ApiError.notFound('path', body.path);
      // No host trash: a recursive force-remove, mirroring the client's confirm.
      rmSync(target, { recursive: true, force: true });
      return c.json<FsOpResponse>({ ok: true, path: body.path });
    });
}
