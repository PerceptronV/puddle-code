import { z } from 'zod';
import { isoTimestamp, rowId } from './common.js';

export const repoSchema = z.object({
  id: rowId,
  path: z.string(),
  default_base_branch: z.string(),
  onboarding_notes: z.string().nullable(),
  fetch_enabled: z.boolean(),
  last_fetched_at: isoTimestamp.nullable(),
});
export type Repo = z.infer<typeof repoSchema>;

/** GET /api/repos items: repo plus worktree dirs on disk that no session row claims. */
export const repoWithOrphansSchema = repoSchema.extend({
  orphan_worktrees: z.array(z.string()),
});
export type RepoWithOrphans = z.infer<typeof repoWithOrphansSchema>;

export const createRepoRequestSchema = z.object({
  path: z.string().min(1),
  default_base_branch: z.string().min(1).optional(),
  onboarding_notes: z.string().nullable().optional(),
  fetch_enabled: z.boolean().optional(),
});

/** One branch in GET /api/repos/:id/branches, annotated when a puddle session owns it. */
export const repoBranchSchema = z.object({
  name: z.string(),
  is_session: z.boolean(),
  session_title: z.string().nullable(),
});
export type RepoBranch = z.infer<typeof repoBranchSchema>;

/** GET /api/repos/:id/branches — local and fetched remote heads, deduped. */
export const repoBranchesResponseSchema = z.object({
  branches: z.array(repoBranchSchema),
});
export type RepoBranchesResponse = z.infer<typeof repoBranchesResponseSchema>;

/** One checked-out git worktree of a repo (GET /api/repos/:id/worktrees). */
export const worktreeInfoSchema = z.object({
  /** The directory. For the primary worktree this is the repo's own clone path. */
  path: z.string(),
  /** The branch checked out there; null when detached. */
  branch: z.string().nullable(),
  /** True for the repo's own clone (the main working tree — never removed by puddle). */
  is_primary: z.boolean(),
  /**
   * Whether the working tree has uncommitted changes. Present on the worktrees
   * list (which computes it); omitted where a lean list is enough. A dirty
   * worktree cannot be pruned (its changes would be lost).
   */
  dirty: z.boolean().optional(),
  /**
   * Whether the branch has commits that are on no remote (purely local work).
   * Pruning such a worktree asks for confirmation. Present on the worktrees list.
   */
  local_only: z.boolean().optional(),
});
export type WorktreeInfo = z.infer<typeof worktreeInfoSchema>;

/** GET /api/repos/:id/worktrees — every git worktree currently checked out. */
export const repoWorktreesResponseSchema = z.object({
  worktrees: z.array(worktreeInfoSchema),
});
export type RepoWorktreesResponse = z.infer<typeof repoWorktreesResponseSchema>;

export const patchRepoRequestSchema = z.object({
  default_base_branch: z.string().min(1).optional(),
  onboarding_notes: z.string().nullable().optional(),
  fetch_enabled: z.boolean().optional(),
});
