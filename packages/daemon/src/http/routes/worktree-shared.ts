import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import type { Context } from 'hono';
import type { Session } from '@puddle/shared';
import type { SessionStore } from '../../db/stores/sessions.js';
import { ApiError } from '../errors.js';
import { expandTilde } from '../tilde.js';

/**
 * Shared guard for every worktree-scoped route: the session must exist
 * (`SessionStore.get` throws 404) and its worktree must still be on disk
 * (409 `worktree_missing` otherwise — e.g. archived-and-removed, or force-
 * removed out of band).
 */
export function resolveWorktree(
  sessions: SessionStore,
  c: Context,
): { session: Session; root: string } {
  const session = sessions.get(c.req.param('sid') ?? '');
  if (!existsSync(session.worktree_path)) {
    throw ApiError.conflict('worktree_missing', `session ${session.id} has no worktree on disk`);
  }
  return { session, root: session.worktree_path };
}

/**
 * Resolve a client-supplied `rel` path against the worktree `root`, rejecting
 * path-injection escapes. Mirrors the confinement check in `src/http/static.ts`
 * (normalise-then-prefix-check): the `rel` must be relative and must not use
 * `..` to climb above `root` — the caller can never name a path outside the
 * worktree directly.
 *
 * Symlinks ARE followed, even when their target lives outside the worktree: a
 * symlink is a real filesystem object the user (or their tools) placed in the
 * worktree, so following it is intended — `./workspaces` linked to a shared dir
 * browses and edits as expected. The `..` normalisation happens lexically,
 * BEFORE any symlink is resolved, so it can only cancel earlier path segments,
 * never walk the external filesystem: through a symlink you reach exactly the
 * target and its subtree, nothing beside or above it. This is a deliberate
 * relaxation of an earlier realpath-based escape guard — puddle runs as the
 * user, who already has shell access to whatever a worktree symlink points at.
 */
/**
 * The effective root for the file routes (protocol 10.2, writes 10.4): an
 * optional absolute `?root=` query overrides the session's worktree so the
 * explorer can walk parent directories and `external` tabs can read AND save
 * their files (SPEC §8). Trusted single-user box — the token holder already
 * has a shell, so touching files anywhere grants nothing new (the same
 * rationale as `GET /api/fs/dirs`). The fs MUTATION routes (create/rename/
 * copy/delete/upload) deliberately never call this: the browse tree offers
 * no such actions, and a stray relative path there must never land outside
 * the worktree. Paths under the override still go through `containedPath`
 * against the OVERRIDDEN root, keeping the `..`-escape guard.
 */
export function browseRoot(c: Context, worktreeRoot: string): string {
  const raw = c.req.query('root');
  if (raw === undefined || raw === '') return worktreeRoot;
  const root = normalize(expandTilde(raw));
  if (!isAbsolute(root)) {
    throw ApiError.badRequest('invalid_root', `'root' must be an absolute path`);
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw ApiError.notFound('root', raw);
  }
  return root;
}

export function containedPath(root: string, rel: string): string {
  if (isAbsolute(rel)) {
    throw ApiError.badRequest('path_outside_worktree', `path must be relative to the worktree`);
  }
  const candidate = normalize(join(root, rel));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw ApiError.badRequest('path_outside_worktree', `path escapes the worktree`);
  }
  return candidate;
}
