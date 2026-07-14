import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import type { Context } from 'hono';
import type { Session } from '@puddle/shared';
import type { SessionStore } from '../../db/stores/sessions.js';
import { ApiError } from '../errors.js';

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
 * any attempt to escape it. Mirrors the confinement check in `src/http/static.ts`
 * (normalise-then-prefix-check) plus a symlink hardening pass: the nearest
 * existing ancestor of the candidate is resolved with `realpathSync` and
 * re-checked against the worktree's own real path, so a symlink planted
 * inside the worktree (or the worktree path itself sitting behind one, as
 * macOS temp dirs do) can't be used to read or write outside it.
 */
export function containedPath(root: string, rel: string): string {
  if (isAbsolute(rel)) {
    throw ApiError.badRequest('path_outside_worktree', `path must be relative to the worktree`);
  }
  const candidate = normalize(join(root, rel));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw ApiError.badRequest('path_outside_worktree', `path escapes the worktree`);
  }

  const realRoot = realpathSync(root);
  let ancestor = candidate;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break; // reached the filesystem root without finding one
    ancestor = parent;
  }
  const realAncestor = realpathSync(ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + sep)) {
    throw ApiError.badRequest('path_outside_worktree', `path escapes the worktree`);
  }
  return candidate;
}
