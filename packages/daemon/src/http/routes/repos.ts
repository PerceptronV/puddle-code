import { isAbsolute } from 'node:path';
import { Hono } from 'hono';
import {
  createRepoRequestSchema,
  patchRepoRequestSchema,
  type RepoWithOrphans,
} from '@puddle/shared';
import type { RepoStore } from '../../db/stores/repos.js';
import { git } from '../../git/exec.js';
import type { WorktreeManager } from '../../worktrees/manager.js';
import { ApiError } from '../errors.js';
import { expandTilde } from '../tilde.js';
import { idParam, parseBody } from '../validate.js';

export interface RepoRouteDeps {
  repos: RepoStore;
  worktrees: WorktreeManager;
}

export function repoRoutes(deps: RepoRouteDeps): Hono {
  return new Hono()
    .get('/', (c) =>
      c.json<RepoWithOrphans[]>(
        deps.repos
          .list()
          .map((r) => ({ ...r, orphan_worktrees: deps.worktrees.findOrphanWorktrees(r) })),
      ),
    )
    .post('/', async (c) => {
      const body = await parseBody(c, createRepoRequestSchema);
      const path = expandTilde(body.path);
      if (!isAbsolute(path)) {
        throw ApiError.badRequest('relative_path', 'repo path must be absolute (or start with ~)');
      }
      try {
        await git(['rev-parse', '--git-dir'], { cwd: path });
      } catch {
        throw ApiError.badRequest('not_a_git_repo', `${path} is not an existing git repository`);
      }
      // Idempotent: registering an already-known path returns the existing
      // repo (the UI can't always tell — ~ paths expand only on the host).
      const existing = deps.repos.list().find((r) => r.path === path);
      if (existing) return c.json(existing);
      const repo = deps.repos.create({
        path,
        default_base_branch: body.default_base_branch ?? 'main',
        onboarding_notes: body.onboarding_notes ?? null,
        fetch_enabled: body.fetch_enabled ?? true,
      });
      return c.json(repo, 201);
    })
    .patch('/:id', async (c) => {
      const body = await parseBody(c, patchRepoRequestSchema);
      return c.json(deps.repos.patch(idParam(c), body));
    })
    .post('/:id/fetch', async (c) => {
      const repo = deps.repos.get(idParam(c));
      try {
        await deps.worktrees.fetchRepo(repo);
      } catch (e) {
        throw new ApiError(502, 'fetch_failed', (e as Error).message);
      }
      return c.json(deps.repos.get(repo.id));
    });
}
