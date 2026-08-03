import { z } from 'zod';
import { isoTimestamp, profileId, projectId, rowId } from './common.js';
import { sessionSchema } from './sessions.js';

/**
 * The compact label the collapsed sidebar rail shows for a project (12.1,
 * SPEC §12): at most five characters, stored uppercase. Null on projects
 * created before the field existed — displays derive from the name then.
 */
const projectAbbrev = z.string().min(1).max(5);

export const projectSchema = z.object({
  id: projectId,
  profile_id: profileId,
  repo_id: rowId,
  name: z.string(),
  abbrev: projectAbbrev.nullable().default(null),
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
  abbrev: projectAbbrev.optional(),
});

/** PATCH /api/projects/:id — rename/re-abbreviate and/or archive/unarchive a project. */
export const patchProjectRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  abbrev: projectAbbrev.optional(),
  archived: z.boolean().optional(),
});

export const projectDetailSchema = z.object({
  project: projectSchema,
  sessions: z.array(sessionSchema),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;
