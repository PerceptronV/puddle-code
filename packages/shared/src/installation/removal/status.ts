import { z } from 'zod';

/** Trusted OS/SSH inspection only. Recorded progress is not service health or adoption proof. */
export const hostRemovalStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('none') }).strict(),
  z
    .object({
      state: z.enum(['removing', 'removed', 'restoring', 'restored']),
      id: z.uuid(),
    })
    .strict(),
]);
export type HostRemovalStatus = z.infer<typeof hostRemovalStatusSchema>;
