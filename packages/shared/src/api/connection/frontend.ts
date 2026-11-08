import { z } from 'zod';

/** Frontend-local controls are authenticated independently of the daemon. */
export const frontendRefreshRequestSchema = z.object({ refreshId: z.string().uuid() }).strict();
export const frontendRefreshResponseSchema = z.object({
  status: z.literal('refreshing'),
  refreshId: z.string().uuid(),
  instance: z.string().uuid(),
});
export type FrontendRefreshResponse = z.infer<typeof frontendRefreshResponseSchema>;

/** Client-machine file manager, advertised only by a local-host frontend. */
export const frontendFileManagerSchema = z.object({
  name: z.enum(['Finder', 'File Explorer', 'File Manager']).nullable(),
});
export type FrontendFileManager = z.infer<typeof frontendFileManagerSchema>;

export const frontendRevealRequestSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((path) => !path.includes('\0')),
  })
  .strict();
export type FrontendRevealRequest = z.infer<typeof frontendRevealRequestSchema>;
