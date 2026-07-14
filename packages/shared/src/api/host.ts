import { z } from 'zod';

/**
 * GET /api/host: who and where the daemon is. The browser cannot tell a
 * local daemon from a tunnelled one (both arrive as 127.0.0.1), so the UI
 * shows this instead of anything derived from the origin — ports never
 * surface in the UI.
 */
export const hostInfoSchema = z.object({
  username: z.string(),
  hostname: z.string(),
  /** The daemon user's home directory, for ~-compressing displayed paths. */
  home: z.string(),
});
export type HostInfo = z.infer<typeof hostInfoSchema>;
