import { z } from 'zod';
import { isoTimestamp, profileId, projectId, rowId } from './common.js';
import { sessionSchema } from './sessions.js';

export const projectSchema = z.object({
  id: projectId,
  profile_id: profileId,
  repo_id: rowId,
  name: z.string(),
  /**
   * Hidden from the homescreen but never deleted — every session, worktree, and
   * bit of data is retained, and un-archiving restores it all (SPEC §11).
   * Defaults false so an older daemon that omits it reads as not-archived.
   */
  archived: z.boolean().default(false),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectRequestSchema = z.object({
  profile_id: profileId,
  repo_id: rowId,
  name: z.string().min(1).max(100),
});

/** PATCH /api/projects/:id — rename and/or archive/unarchive a project. */
export const patchProjectRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  archived: z.boolean().optional(),
});

export const projectDetailSchema = z.object({
  project: projectSchema,
  sessions: z.array(sessionSchema),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;
