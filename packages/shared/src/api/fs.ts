import { z } from 'zod';

/**
 * GET /api/fs/dirs?prefix=<absolute path fragment>: directory autocomplete
 * for repo registration. Directories only, dotdirs included; `is_git` marks
 * ones containing a .git entry.
 */
export const fsDirEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  is_git: z.boolean(),
});
export type FsDirEntry = z.infer<typeof fsDirEntrySchema>;

export const fsDirsResponseSchema = z.object({
  entries: z.array(fsDirEntrySchema),
});
export type FsDirsResponse = z.infer<typeof fsDirsResponseSchema>;
