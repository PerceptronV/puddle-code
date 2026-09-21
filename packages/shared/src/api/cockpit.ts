import { z } from 'zod';

/** Cockpit-local controls are authenticated independently of the daemon. */
export const cockpitRefreshRequestSchema = z.object({ refreshId: z.string().uuid() }).strict();
export const cockpitRefreshResponseSchema = z.object({
  status: z.literal('refreshing'),
  refreshId: z.string().uuid(),
  instance: z.string().uuid(),
});
export type CockpitRefreshResponse = z.infer<typeof cockpitRefreshResponseSchema>;
