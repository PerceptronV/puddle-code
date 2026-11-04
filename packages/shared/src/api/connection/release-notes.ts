import { z } from 'zod';

export const RELEASE_NOTES_MAX_BYTES = 256 * 1024;

export const releaseNotesSchema = z.object({
  releases: z
    .array(
      z.object({
        component: z.enum(['daemon', 'runtime']),
        version: z.string().min(1).max(128),
        markdown: z
          .string()
          .min(1)
          .max(RELEASE_NOTES_MAX_BYTES)
          .refine((value) => new TextEncoder().encode(value).length <= RELEASE_NOTES_MAX_BYTES),
      }),
    )
    .max(2)
    .refine((entries) => new Set(entries.map((entry) => entry.component)).size === entries.length),
});
export type ReleaseNotes = z.infer<typeof releaseNotesSchema>;
