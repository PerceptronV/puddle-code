import { z } from 'zod';
import { isoTimestamp, rowId, sessionId } from './common.js';

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
  project_id: rowId,
  account_id: rowId,
  worktree_path: z.string(),
  base_branch: z.string(),
  branch: z.string(),
  agent_type: z.string(),
  agent_session_ref: z.string().nullable(),
  title: z.string().nullable(),
  status: sessionStatusSchema,
  skip_permissions: z.boolean(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  last_activity_at: isoTimestamp.nullable(),
});
export type Session = z.infer<typeof sessionSchema>;

export const createSessionRequestSchema = z.object({
  project_id: rowId,
  account_id: rowId,
  base_branch: z.string().min(1).optional(),
  branch: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(200).optional(),
  prompt: z.string().optional(),
  skip_permissions: z.boolean().optional(),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const patchSessionRequestSchema = z.object({ title: z.string().min(1).max(200) });

/** Shared by session archive and project archive (kill/discard confirmation). */
export const archiveRequestSchema = z.object({ force: z.boolean().default(false) });
