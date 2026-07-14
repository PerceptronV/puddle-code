import { z } from 'zod';

/** Uniform error envelope for every non-2xx API response. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const isoTimestamp = z.iso.datetime();

/** SQLite integer primary keys. */
export const rowId = z.number().int().positive();

/** Puddle session ids are uuids (also reused as claude-code session ids). */
export const sessionId = z.uuid();

/** Project ids are 10 hex chars — short, stable URL handles (/project/:id). */
export const projectId = z.string().regex(/^[0-9a-f]{10}$/);

/** Profile ids are 10 hex chars — opaque handles; names are display labels only. */
export const profileId = z.string().regex(/^[0-9a-f]{10}$/);
