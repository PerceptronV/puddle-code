import { z } from 'zod';

/** Uniform error envelope for every non-2xx API response. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * `{offset: true}` because git's strict-ISO `%aI` (used for commit timestamps,
 * see worktree-git.ts) renders the author's recorded UTC offset verbatim
 * (e.g. `-07:00`) and only degenerates to `Z` when that offset is zero — a
 * real commit made in a non-UTC timezone would otherwise fail this schema.
 * Purely additive: existing `Z`-suffixed timestamps (`new Date().toISOString()`
 * elsewhere in the daemon) still validate.
 */
export const isoTimestamp = z.iso.datetime({ offset: true });

/** SQLite integer primary keys. */
export const rowId = z.number().int().positive();

/** Puddle session ids are uuids (also reused as claude-code session ids). */
export const sessionId = z.uuid();

/** Project ids are 10 hex chars — short, stable URL handles (/project/:id). */
export const projectId = z.string().regex(/^[0-9a-f]{10}$/);

/** Profile ids are 10 hex chars — opaque handles; names are display labels only. */
export const profileId = z.string().regex(/^[0-9a-f]{10}$/);
