import { isAbsolute, join, normalize, sep } from 'node:path';
import { Hono } from 'hono';
import type {
  DiffResponse,
  FileAtResponse,
  LogResponse,
  SearchResponse,
  ShowCommitResponse,
} from '@puddle/shared';
import type { SessionStore } from '../../db/stores/sessions.js';
import { git } from '../../git/exec.js';
import {
  assertSafeRef,
  assertSha,
  blobAt,
  diffNameStatus,
  logPage,
  resolveBaseSha,
  resolveHeadSha,
  showCommit,
} from '../../worktrees/inspect.js';
import { searchWorktree } from '../../worktrees/search.js';
import { ApiError } from '../errors.js';
import { resolveWorktree } from './worktree-shared.js';

/** Longest search query we accept — long enough for a phrase, short of abuse. */
const MAX_QUERY_LEN = 500;

/** A `?flag=1`/`true` query param reads as true; everything else (incl. absent) is false. */
function boolParam(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

/** A commit sha or a plausible abbreviation of one — anything else is rejected before it reaches git. */
const SHA_LIKE = /^[0-9a-f]{4,40}$/;

async function commitExists(cwd: string, sha: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

function parseIntParam(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined) return def;
  if (!/^\d+$/.test(raw)) {
    throw ApiError.badRequest('invalid_pagination', `'${raw}' is not a valid non-negative integer`);
  }
  const n = Number(raw);
  if (n < min || n > max) {
    throw ApiError.badRequest(
      'invalid_pagination',
      `value ${n} is outside the allowed range [${min}, ${max}]`,
    );
  }
  return n;
}

/**
 * Relative-path guard for `file-at`: the path keys a git blob, not a
 * filesystem entry, so `containedPath`'s realpath hardening (worktree-shared.ts)
 * doesn't apply here — the path may not exist on disk at all (e.g. a file
 * deleted since `ref`). A normalise-then-prefix check against a virtual root
 * is enough to reject an absolute path or a `..`-escape.
 */
function assertContainedRelPath(rel: string): string {
  if (isAbsolute(rel)) {
    throw ApiError.badRequest('path_outside_worktree', `path must be relative to the worktree`);
  }
  const virtualRoot = '/virtual-root';
  const joined = normalize(join(virtualRoot, rel));
  if (joined !== virtualRoot && !joined.startsWith(virtualRoot + sep)) {
    throw ApiError.badRequest('path_outside_worktree', `path escapes the worktree`);
  }
  return joined === virtualRoot ? '' : joined.slice(virtualRoot.length + 1);
}

/**
 * Read-only git inspection for a session's worktree (SPEC §6/§8, Phase 3
 * history view): diff vs. base or an explicit commit, a file's content at a
 * ref, paginated commit log, and a single commit's detail. No mutex — none
 * of this mutates the repo (precedent: `GET /api/repos/:id/branches`).
 * Mounted by `worktrees.ts`.
 */
export function worktreeGitRoutes(deps: { sessions: SessionStore }): Hono {
  return new Hono()
    .get('/:sid/diff', async (c) => {
      const { session, root } = resolveWorktree(deps.sessions, c);
      const against = c.req.query('against') ?? 'base';

      if (against === 'base') {
        const { sha, ref } = await resolveBaseSha(root, session.base_branch);
        const entries = await diffNameStatus(root, sha);
        return c.json<DiffResponse>({ against: sha, base_ref: ref, entries });
      }

      // Uncommitted changes: working tree (staged + unstaged) vs. HEAD — the
      // Changes navigator's top panel (SPEC §8).
      if (against === 'head') {
        const sha = await resolveHeadSha(root);
        const entries = await diffNameStatus(root, sha);
        return c.json<DiffResponse>({ against: sha, base_ref: 'HEAD', entries });
      }

      if (!SHA_LIKE.test(against)) {
        throw ApiError.badRequest(
          'invalid_against',
          `'against' must be 'base', 'head', or a commit sha`,
        );
      }
      if (!(await commitExists(root, against))) {
        throw new ApiError(404, 'unknown_ref', `commit '${against}' does not exist`);
      }
      const entries = await diffNameStatus(root, against);
      return c.json<DiffResponse>({ against, base_ref: null, entries });
    })

    .get('/:sid/file-at', async (c) => {
      const { root } = resolveWorktree(deps.sessions, c);
      const ref = c.req.query('ref') ?? '';
      assertSafeRef(ref);
      const rel = assertContainedRelPath(c.req.query('path') ?? '');

      const result = await blobAt(root, ref, rel);
      if (result === null) {
        throw new ApiError(404, 'not_at_ref', `no blob at '${rel}' for ref '${ref}'`);
      }
      return c.json<FileAtResponse>({
        path: rel,
        ref,
        content: result.content,
        binary: result.binary,
      });
    })

    .get('/:sid/log', async (c) => {
      const { root } = resolveWorktree(deps.sessions, c);
      const limit = parseIntParam(c.req.query('limit'), 50, 1, 200);
      const skip = parseIntParam(c.req.query('skip'), 0, 0, Number.MAX_SAFE_INTEGER);
      const result = await logPage(root, limit, skip);
      return c.json<LogResponse>(result);
    })

    .get('/:sid/show/:sha', async (c) => {
      const { root } = resolveWorktree(deps.sessions, c);
      const sha = c.req.param('sha');
      assertSha(sha);
      if (!(await commitExists(root, sha))) {
        throw new ApiError(404, 'unknown_ref', `commit '${sha}' does not exist`);
      }
      return c.json<ShowCommitResponse>(await showCommit(root, sha));
    })

    .get('/:sid/search', async (c) => {
      const { root } = resolveWorktree(deps.sessions, c);
      const query = c.req.query('q') ?? '';
      if (query.length === 0) {
        throw ApiError.badRequest('empty_query', `'q' must not be empty`);
      }
      if (query.length > MAX_QUERY_LEN) {
        throw ApiError.badRequest(
          'query_too_long',
          `query is ${query.length} chars; the cap is ${MAX_QUERY_LEN}`,
        );
      }
      const result = await searchWorktree(root, {
        query,
        regex: boolParam(c.req.query('regex')),
        caseSensitive: boolParam(c.req.query('case')),
        wholeWord: boolParam(c.req.query('word')),
      });
      return c.json<SearchResponse>(result);
    });
}
