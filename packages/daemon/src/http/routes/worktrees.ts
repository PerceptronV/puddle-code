import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { Hono } from 'hono';
import {
  pasteImageRequestSchema,
  type PasteImageMime,
  type PasteImageResponse,
  type ResolvePathResponse,
} from '@puddle/shared';
import type { SessionStore } from '../../db/stores/sessions.js';
import { ApiError } from '../errors.js';
import { parseBody } from '../validate.js';
import { worktreeFileRoutes } from './worktree-files.js';
import { worktreeFsOpsRoutes } from './worktree-fs-ops.js';
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
 * clipboard-paste target (§7), the tree/file/upload/download browsing family
 * (§8, `worktree-files.ts`), the create/rename/copy/delete mutation family
 * (§8, `worktree-fs-ops.ts`), and the read-only git inspection family
 * (diff/git-status/file-at/log/show, `worktree-git.ts`).
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

  // GET /:sid/resolve — validates a terminal file-path link before the UI
  // underlines it (SPEC §7, "Terminal links"): the xterm.js link provider
  // asks here on hover, so this must be cheap and must never leak worktree
  // layout. Escape attempts and missing files therefore both collapse to the
  // same plain 404 `not_found` — the client only ever learns "don't
  // underline", never *why* it can't.
  app.get('/:sid/resolve', (c) => {
    const { root } = resolveWorktree(deps.sessions, c);
    const rawPath = c.req.query('path');
    if (!rawPath) {
      throw ApiError.badRequest('invalid_request', `'path' query parameter is required`);
    }

    // Containment is checked against the RAW worktree root, not its
    // realpath: on macOS the worktree commonly sits behind a symlinked
    // tmpdir (/tmp -> /private/tmp), and the only absolute paths a client
    // ever sends are ones it saw as the terminal's cwd — i.e. this same raw
    // root — so comparing raw-to-raw is what makes a legitimate absolute
    // link resolve. `resolve()` ignores `root` entirely when `rawPath` is
    // already absolute, which is exactly the "absolute paths accepted only
    // when inside the worktree" rule.
    const abs = resolve(root, rawPath);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw ApiError.notFound('path', rawPath);
    }
    if (!existsSync(abs)) {
      throw ApiError.notFound('path', rawPath);
    }

    // Symlinks are followed, even out of the worktree — consistent with the
    // file explorer / `containedPath`: only lexical `..`/absolute escapes are
    // rejected (above), never a real symlink the user placed in the worktree.
    // `statSync` follows the link; directories aren't openable in Monaco (v1
    // scope), so a link to one has nothing to point at.
    if (!statSync(abs).isFile()) {
      throw ApiError.notFound('path', rawPath);
    }

    // Relative to the raw root (already validated above) so the response
    // matches the worktree-relative identity every other endpoint uses and
    // the client can feed it straight to the editor tab.
    const relPath = relative(root, abs);
    if (relPath.startsWith('..')) {
      throw ApiError.notFound('path', rawPath); // belt and braces
    }

    const lineParam = c.req.query('line');
    const parsedLine = lineParam === undefined ? NaN : Number.parseInt(lineParam, 10);
    const line = Number.isNaN(parsedLine) ? null : Math.max(1, parsedLine);

    return c.json<ResolvePathResponse>({ path: relPath, line });
  });

  app.route('/', worktreeFileRoutes(deps));
  app.route('/', worktreeFsOpsRoutes(deps));
  app.route('/', worktreeGitRoutes(deps));
  return app;
}
