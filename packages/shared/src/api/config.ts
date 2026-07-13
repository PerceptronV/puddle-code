import { z } from 'zod';

/** Daemon-scope settings persisted in ~/.puddle/config.json. */
export const daemonConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(7433),
  autoResume: z.boolean().default(false),
  fetchIntervalMinutes: z.number().int().min(1).default(15),
  logMaxBytes: z
    .number()
    .int()
    .min(64 * 1024)
    .default(10 * 1024 * 1024),
  replayBytes: z
    .number()
    .int()
    .min(1024)
    .default(256 * 1024),
});
export type DaemonConfig = z.infer<typeof daemonConfigSchema>;

export const daemonConfigPatchSchema = daemonConfigSchema.partial();
export type DaemonConfigPatch = z.infer<typeof daemonConfigPatchSchema>;
