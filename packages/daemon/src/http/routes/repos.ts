import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Hono } from 'hono';
import {
  createRepoRequestSchema,
  patchRepoRequestSchema,
  type RepoBranchesResponse,
  type RepoWithOrphans,
  type RepoWorktreesResponse,
} from '@puddle/shared';
import type { RepoStore } from '../../db/stores/repos.js';
import type { SessionStore } from '../../db/stores/sessions.js';
import { git } from '../../git/exec.js';
import type { WorktreeManager } from '../../worktrees/manager.js';
import { ApiError } from '../errors.js';
import { expandTilde } from '../tilde.js';
import { idParam, parseBody } from '../validate.js';

export interface RepoRouteDeps {
  repos: RepoStore;
  sessions: SessionStore;
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
    .get('/:id/branches', async (c) => {
      const repo = deps.repos.get(idParam(c));
      // Local heads plus fetched remote heads, deduped to short names — the
      // worktree manager resolves origin/<base> itself when present (§4).
      const out = await git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], {
        cwd: repo.path,
      });
      const names = new Set<string>();
      for (const ref of out.split('\n')) {
        if (ref.startsWith('refs/heads/')) {
          names.add(ref.slice('refs/heads/'.length));
        } else {
          const remote = /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref);
          if (remote && remote[1] !== 'HEAD') names.add(remote[1]!);
        }
      }
      // Branches created by puddle sessions carry the session's title so
      // the picker can say what they are instead of showing a bare name.
      const sessionTitles = new Map(
        deps.sessions.branchesForRepo(repo.id).map((s) => [s.branch, s.title]),
      );
      const branches = [...names]
        .sort((a, b) =>
          // The repo's default base branch leads the list.
          a === repo.default_base_branch
            ? -1
            : b === repo.default_base_branch
              ? 1
              : a.localeCompare(b),
        )
        .map((name) => ({
          name,
          is_session: sessionTitles.has(name),
          session_title: sessionTitles.get(name) ?? null,
        }));
      return c.json<RepoBranchesResponse>({ branches });
    })
    .get('/:id/worktrees', async (c) => {
      const repo = deps.repos.get(idParam(c));
      return c.json<RepoWorktreesResponse>({
        worktrees: await deps.worktrees.listWorktreeStatuses(repo),
        orphan_branches: await deps.worktrees.listOrphanBranches(repo),
      });
    })
    .delete('/:id/worktrees', async (c) => {
      const repo = deps.repos.get(idParam(c));
      const path = c.req.query('path');
      if (!path) {
        throw ApiError.badRequest('invalid_request', `'path' query parameter is required`);
      }
      const real = (p: string) => {
        try {
          return realpathSync(p);
        } catch {
          return p;
        }
      };

      const worktrees = await deps.worktrees.listWorktrees(repo);
      const target = worktrees.find((w) => w.path === path || real(w.path) === real(path));
      if (!target) throw ApiError.notFound('worktree', path);
      if (target.is_primary) {
        throw ApiError.conflict('worktree_primary', 'the repository clone cannot be pruned');
      }

      // Running agents block pruning (SPEC §8): only live sessions, not
      // exited/interrupted ones (removing the worktree just badges those
      // "worktree missing"). Removing a worktree keeps its branch, so there is
      // no unpushed-work risk here — that guard lives on branch deletion.
      const LIVE = new Set(['starting', 'running', 'waiting_input']);
      const busy = deps.sessions
        .listActiveByRepo(repo.id)
        .filter((s) => LIVE.has(s.status) && real(s.worktree_path) === real(target.path));
      if (busy.length > 0) {
        throw ApiError.conflict(
          'worktree_busy',
          `${busy.length} running session(s) still use this worktree — stop them first`,
        );
      }

      // Uncommitted changes would be lost — never prune a dirty worktree.
      if (!(await deps.worktrees.isClean(target.path))) {
        throw ApiError.conflict(
          'worktree_dirty',
          'the worktree has uncommitted changes — commit or discard them first',
        );
      }

      await deps.worktrees.remove({ repo, worktreePath: target.path, force: false });
      return c.json<RepoWorktreesResponse>({
        worktrees: await deps.worktrees.listWorktreeStatuses(repo),
        orphan_branches: await deps.worktrees.listOrphanBranches(repo),
      });
    })
    .delete('/:id/branches', async (c) => {
      const repo = deps.repos.get(idParam(c));
      const name = c.req.query('name');
      if (!name) {
        throw ApiError.badRequest('invalid_request', `'name' query parameter is required`);
      }
      const confirm = c.req.query('confirm') === '1' || c.req.query('confirm') === 'true';

      const orphan = (await deps.worktrees.listOrphanBranches(repo)).find((b) => b.name === name);
      if (!orphan) {
        // Either the branch doesn't exist or it still has a worktree checked out.
        const local = (await deps.worktrees.listWorktrees(repo)).some((w) => w.branch === name);
        if (local) {
          throw ApiError.conflict(
            'branch_in_use',
            `branch '${name}' still has a worktree — prune it first`,
          );
        }
        throw ApiError.notFound('branch', name);
      }
      // Deleting an unpushed branch discards its commits — require confirmation.
      if (orphan.local_only && !confirm) {
        throw ApiError.conflict(
          'branch_unpushed',
          `branch '${name}' has commits on no remote — confirm to delete anyway`,
        );
      }
      await deps.worktrees.deleteBranch(repo, name);
      return c.json<RepoWorktreesResponse>({
        worktrees: await deps.worktrees.listWorktreeStatuses(repo),
        orphan_branches: await deps.worktrees.listOrphanBranches(repo),
      });
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
