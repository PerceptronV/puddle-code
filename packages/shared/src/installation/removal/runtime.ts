import { z } from 'zod';

export const HOST_REMOVAL_RUNTIME_LIMIT = 1024;
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
/** Public interruption impact only; pinned paths and native conversation identities stay on the host. */
export const hostRemovalRuntimeReviewSchema = z
  .object({
    id: z.uuid(),
    fingerprint,
    owners: z
      .array(
        z
          .object({
            id: z.uuid(),
            session: z.string().min(1).max(128),
            version: z.string().min(1).max(128),
            terminals: z.number().int().nonnegative().max(1024).nullable(),
            stop_blocker: z.enum(['unavailable', 'unsaved', 'stop_pending']).nullable(),
          })
          .strict(),
      )
      .max(HOST_REMOVAL_RUNTIME_LIMIT),
  })
  .strict();
export type HostRemovalRuntimeReview = z.infer<typeof hostRemovalRuntimeReviewSchema>;

export const hostRemovalFinishSchema = z
  .object({
    id: z.uuid(),
    fingerprint,
    attempt_id: z.uuid(),
    disposition: z.enum(['retain', 'stop']),
  })
  .strict();
export type HostRemovalFinish = z.infer<typeof hostRemovalFinishSchema>;
