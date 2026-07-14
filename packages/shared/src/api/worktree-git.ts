import { z } from 'zod';
import { isoTimestamp } from './common.js';

/**
 * Git-inspection shapes for a session's worktree — diff, blame-free file
 * lookups at a ref, and commit history (SPEC §6/§8, Phase 3 history view).
 */
export const diffStatusSchema = z.enum(['added', 'modified', 'deleted', 'renamed']);
export type DiffStatus = z.infer<typeof diffStatusSchema>;

export const diffEntrySchema = z.object({
  path: z.string(),
  status: diffStatusSchema,
  /** Pre-rename path; null unless `status` is `renamed`. */
  old_path: z.string().nullable(),
});
export type DiffEntry = z.infer<typeof diffEntrySchema>;

/** `GET /api/worktrees/:sid/diff?against=base|<sha>` — working tree vs. a base. */
export const diffResponseSchema = z.object({
  /** The resolved sha the working tree was actually diffed against. */
  against: z.string(),
  /** e.g. `origin/main`; null when `against` was given as a literal sha. */
  base_ref: z.string().nullable(),
  entries: z.array(diffEntrySchema),
});
export type DiffResponse = z.infer<typeof diffResponseSchema>;

/** `GET /api/worktrees/:sid/file-at?ref=…&path=…` — a file's content at a ref. */
export const fileAtResponseSchema = z.object({
  path: z.string(),
  ref: z.string(),
  content: z.string().nullable(),
  binary: z.boolean(),
});
export type FileAtResponse = z.infer<typeof fileAtResponseSchema>;

export const commitSummarySchema = z.object({
  sha: z.string(),
  subject: z.string(),
  author_name: z.string(),
  author_email: z.string(),
  authored_at: isoTimestamp,
  /**
   * Parent shas, oldest-listed-first as git reports them. Optional: older
   * daemons omit it and the history list renders without a graph. Drives the
   * commit-graph lane layout in the unified Changes navigator (SPEC §8).
   */
  parents: z.array(z.string()).optional(),
});
export type CommitSummary = z.infer<typeof commitSummarySchema>;

/** `GET /api/worktrees/:sid/log?limit=…&skip=…` — paginated commit history. */
export const logResponseSchema = z.object({
  commits: z.array(commitSummarySchema),
  has_more: z.boolean(),
});
export type LogResponse = z.infer<typeof logResponseSchema>;

/** `GET /api/worktrees/:sid/show/:sha` — a single commit's message and file changes. */
export const showCommitResponseSchema = z.object({
  commit: commitSummarySchema.extend({ body: z.string() }),
  parents: z.array(z.string()),
  files: z.array(diffEntrySchema),
});
export type ShowCommitResponse = z.infer<typeof showCommitResponseSchema>;
