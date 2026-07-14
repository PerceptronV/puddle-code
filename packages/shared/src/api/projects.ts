import { z } from 'zod';
import { isoTimestamp, profileId, projectId, rowId } from './common.js';
import { sessionSchema } from './sessions.js';

export const projectSchema = z.object({
  id: projectId,
  profile_id: profileId,
  repo_id: rowId,
  name: z.string(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectRequestSchema = z.object({
  profile_id: profileId,
  repo_id: rowId,
  name: z.string().min(1).max(100),
});

export const projectDetailSchema = z.object({
  project: projectSchema,
  sessions: z.array(sessionSchema),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;
