import { z } from 'zod';
import { hostStageRecordSchema } from './stage.js';

export const HOST_RELEASE_COLLECTION_LIMIT = 32;
export const HOST_RELEASE_COLLECTION_BYTES = 64 * 1024;

/** Private, bounded filesystem intent; never authority to retire a runtime or native session. */
export const hostReleaseCollectionSchema = z
  .object({
    format: z.literal(1),
    id: z.uuid(),
    home: z.string().min(1).max(4096),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    releases: z
      .array(
        z
          .object({
            generation: hostStageRecordSchema.shape.generation,
            device: z.number().int().nonnegative().safe(),
            inode: z.number().int().nonnegative().safe(),
            receipt: z.string().regex(/^[a-f0-9]{64}$/),
            publishedAt: z.number().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(HOST_RELEASE_COLLECTION_LIMIT),
    actions: z
      .array(
        z
          .object({
            action: hostStageRecordSchema.shape.generation,
            state: z.enum(['planned', 'started', 'finished']),
          })
          .strict(),
      )
      .min(1)
      .max(HOST_RELEASE_COLLECTION_LIMIT),
  })
  .strict()
  .superRefine((record, context) => {
    const generations = record.releases.map(({ generation }) => generation);
    if (
      new Set(generations).size !== generations.length ||
      JSON.stringify(generations) !== JSON.stringify(record.actions.map(({ action }) => action))
    )
      context.addIssue({
        code: 'custom',
        message: 'Collection actions do not match the accepted releases',
      });
    let unfinished = false;
    for (const { state } of record.actions) {
      if (unfinished && state !== 'planned')
        context.addIssue({ code: 'custom', message: 'Collection actions are not a serial prefix' });
      if (state !== 'finished') unfinished = true;
    }
  });
export type HostReleaseCollection = z.infer<typeof hostReleaseCollectionSchema>;
