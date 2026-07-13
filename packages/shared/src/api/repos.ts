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

export const patchRepoRequestSchema = z.object({
  default_base_branch: z.string().min(1).optional(),
  onboarding_notes: z.string().nullable().optional(),
  fetch_enabled: z.boolean().optional(),
});
