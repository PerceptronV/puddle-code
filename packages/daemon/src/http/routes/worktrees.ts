import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  pasteImageRequestSchema,
  type PasteImageMime,
  type PasteImageResponse,
} from '@puddle/shared';
import type { SessionStore } from '../../db/stores/sessions.js';
import { ApiError } from '../errors.js';
import { parseBody } from '../validate.js';
import { worktreeFileRoutes } from './worktree-files.js';
import { worktreeGitRoutes } from './worktree-git.js';
import { resolveWorktree } from './worktree-shared.js';

/** Decoded-size cap for pasted images; generous for screenshots, hostile to abuse. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const EXTENSION: Record<PasteImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Worktree-scoped routes (SPEC §6, Files): thin aggregator over the
 * clipboard-paste target (§7), the tree/file/upload/download family
 * (§8, `worktree-files.ts`), and the read-only git inspection family
 * (diff/file-at/log/show, `worktree-git.ts`).
 */
export function worktreeRoutes(deps: { sessions: SessionStore }): Hono {
  const app = new Hono();

  app.post('/:sid/paste', async (c) => {
    const { session } = resolveWorktree(deps.sessions, c);
    const body = await parseBody(c, pasteImageRequestSchema);
    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.byteLength === 0) {
      throw ApiError.badRequest('invalid_image', `'data' is not valid base64`);
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw ApiError.badRequest(
        'image_too_large',
        `pasted image is ${bytes.byteLength} bytes; the cap is ${MAX_IMAGE_BYTES}`,
      );
    }

    // .puddle/ is git-excluded per repo (worktree manager), so pastes never
    // show up in diffs or commits. Timestamp + random suffix: unique without
    // coordination, and sorts chronologically for humans.
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const name = `paste-${stamp}-${randomBytes(3).toString('hex')}.${EXTENSION[body.mime]}`;
    const dir = join(session.worktree_path, '.puddle', 'pastes');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), bytes);

    return c.json<PasteImageResponse>({ path: `.puddle/pastes/${name}` }, 201);
  });

  app.route('/', worktreeFileRoutes(deps));
  app.route('/', worktreeGitRoutes(deps));
  return app;
}
