import { z } from 'zod';
import { isoTimestamp, projectId, rowId, sessionId } from './common.js';

export const sessionStatusSchema = z.enum([
  'starting',
  'running',
  'waiting_input',
  'exited',
  'interrupted',
  'archived',
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionSchema = z.object({
  id: sessionId,
  project_id: projectId,
  account_id: rowId,
  worktree_path: z.string(),
  base_branch: z.string(),
  branch: z.string(),
  /** False: the session works directly on the base branch in a shared worktree (SPEC §4). */
  separate_branch: z.boolean(),
  agent_type: z.string(),
  agent_session_ref: z.string().nullable(),
  title: z.string().nullable(),
  status: sessionStatusSchema,
  skip_permissions: z.boolean(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  last_activity_at: isoTimestamp.nullable(),
  /** Computed on read: the worktree dir is gone; the session can only be archived. */
  worktree_missing: z.boolean().optional(),
  /**
   * Ahead/behind counts vs. the base branch plus a dirty-file count. Optional:
   * older daemons omit it, and it is computed only on the single-session GET
   * (`GET /api/sessions/:id`) — never on the list endpoint, where it would be
   * too expensive to compute per row.
   */
  git_summary: z
    .object({
      ahead: z.number().int().nonnegative(),
      behind: z.number().int().nonnegative(),
      dirty_files: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
});
export type Session = z.infer<typeof sessionSchema>;

export const createSessionRequestSchema = z.object({
  project_id: projectId,
  account_id: rowId,
  base_branch: z.string().min(1).optional(),
  branch: z.string().min(1).max(200).optional(),
  /**
   * Default true: fresh branch, fresh worktree. False (discouraged): work
   * directly on the base branch in a worktree shared with every other such
   * session — `branch` must then be absent (SPEC §4).
   */
  separate_branch: z.boolean().optional(),
  title: z.string().min(1).max(200).optional(),
  prompt: z.string().optional(),
  skip_permissions: z.boolean().optional(),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const patchSessionRequestSchema = z.object({ title: z.string().min(1).max(200) });

/**
 * `POST /api/sessions/:id/migrate` — tier-1 migration (SPEC §5, §6): move a
 * session to another account of the SAME (profile, agent) and resume it there.
 * The conversation itself does not move — it lives in the profile's shared
 * conversation store, reachable from every account (§S) — so migration is
 * "stop the process, repoint `account_id`, resume under the target's
 * credentials". Returns the updated session detail; `skip_permissions` is
 * re-evaluated for the target at resume time (§11.4).
 */
export const migrateSessionRequestSchema = z.object({ account_id: rowId });
export type MigrateSessionRequest = z.infer<typeof migrateSessionRequestSchema>;

/** Shared by session archive and project archive (kill/discard confirmation). */
export const archiveRequestSchema = z.object({
  force: z.boolean().default(false),
  /**
   * Also delete the session's git branch (`git branch -D` — unpushed work is
   * gone for good). Only valid for separate-branch sessions; project archive
   * never deletes branches (SPEC §4).
   */
  delete_branch: z.boolean().default(false),
});
