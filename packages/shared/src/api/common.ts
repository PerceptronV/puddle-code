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
