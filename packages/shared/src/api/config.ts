import { z } from 'zod';

/**
 * Field validators without defaults. The patch schema must be built from
 * these: zod's `.partial()` on a defaulted field still fills the default,
 * so a patch schema derived from the defaulted object would silently reset
 * every field the patch omits.
 */
const fields = {
  port: z.number().int().min(1).max(65535),
  autoResume: z.boolean(),
  fetchIntervalMinutes: z.number().int().min(1),
  logMaxBytes: z
    .number()
    .int()
    .min(64 * 1024),
  replayBytes: z.number().int().min(1024),
  /** Days a (project, profile) ui_state row survives without an update. */
  uiStateRetentionDays: z.number().int().min(1),
};

/** Daemon-scope settings persisted in ~/.puddle/config.json. */
export const daemonConfigSchema = z.object({
  port: fields.port.default(7434),
  autoResume: fields.autoResume.default(false),
  fetchIntervalMinutes: fields.fetchIntervalMinutes.default(15),
  logMaxBytes: fields.logMaxBytes.default(10 * 1024 * 1024),
  replayBytes: fields.replayBytes.default(256 * 1024),
  uiStateRetentionDays: fields.uiStateRetentionDays.default(90),
});
export type DaemonConfig = z.infer<typeof daemonConfigSchema>;

export const daemonConfigPatchSchema = z.object(fields).partial();
export type DaemonConfigPatch = z.infer<typeof daemonConfigPatchSchema>;
