import { z } from 'zod';
import { isoTimestamp, profileId } from './common.js';

/** Filesystem-safe: profile names become directory names under ~/.puddle/profiles/. */
export const fsSafeName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'letters, digits, dot, underscore and hyphen only');

export const profileSchema = z.object({
  id: profileId,
  name: fsSafeName,
  branch_prefix: z.string(),
  created_at: isoTimestamp,
});
export type Profile = z.infer<typeof profileSchema>;

export const createProfileRequestSchema = z.object({
  name: fsSafeName,
  branch_prefix: z.string().max(64).optional(),
});

/** PATCH /api/profiles/:id — the name is immutable in v1 (a display label; dirs are id-keyed). */
export const patchProfileRequestSchema = z.object({
  branch_prefix: z.string().max(64),
});

/**
 * Profile-scope settings JSON. Loose: later phases add keys (default account,
 * notifications, …) without a daemon migration. Phase 1 validates only the gate.
 */
export const profileSettingsSchema = z.looseObject({
  allowSkipPermissions: z.boolean().default(false),
});
export type ProfileSettings = z.infer<typeof profileSettingsSchema>;

export const patchProfileSettingsRequestSchema = z.record(z.string(), z.unknown());
