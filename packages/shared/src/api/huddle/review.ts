import { z } from 'zod';
import { huddleCommandTargetSchema } from './execution.js';
import { huddleRevisionSchema } from './events.js';
import { huddleDiagnosticSchema } from './definitions.js';
import { HUDDLE_LIMITS, huddleRelativePathSchema, huddleKeySchema } from './values.js';
import {
  HUDDLE_REVISION_LIMITS,
  huddleRevisionActivationSchema,
} from '../../runtime/huddle/revisions.js';

export const huddleReviewEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), path: huddleRelativePathSchema }),
  z.strictObject({ kind: z.literal('component'), path: huddleKeySchema }),
]);
export const huddleRevisionReviewSchema = z.strictObject({
  target: huddleCommandTargetSchema,
  entry: huddleReviewEntrySchema.optional(),
});
export const huddleDiffReviewSchema = huddleRevisionReviewSchema.extend({
  expected_digest: huddleRevisionSchema,
});
const fingerprint = z.strictObject({
  digest: huddleRevisionSchema,
  bytes: z.number().int().nonnegative().max(HUDDLE_REVISION_LIMITS.recordBytes),
});
const text = z
  .string()
  .max(HUDDLE_REVISION_LIMITS.recordBytes)
  .refine((value) => new TextEncoder().encode(value).length <= HUDDLE_REVISION_LIMITS.recordBytes);
export const huddleReviewSchema = z
  .strictObject({
    target: huddleCommandTargetSchema,
    // Deliberate public projection; future private activation fields stay private.
    active: huddleRevisionActivationSchema.pick({
      id: true,
      revision: true,
      worktree: true,
      variables: true,
      bindings: true,
      appliedAt: true,
    }),
    saved: z
      .strictObject({ digest: huddleRevisionSchema, diagnostics: z.array(huddleDiagnosticSchema) })
      .nullable(),
    entries: z
      .array(
        z.strictObject({
          entry: huddleReviewEntrySchema,
          change: z.enum(['retained', 'unchanged', 'added', 'removed', 'modified']),
          before: fingerprint.nullable(),
          after: fingerprint.nullable(),
        }),
      )
      .max(2 * (HUDDLE_LIMITS.files + HUDDLE_LIMITS.nodes)),
    content: z
      .strictObject({
        entry: huddleReviewEntrySchema,
        before: text.nullable(),
        after: text.nullable(),
      })
      .optional(),
  })
  .refine(
    (review) => review.active.id === review.target.activationId,
    'Review activation differs from its target',
  );
export type HuddleReviewEntry = z.infer<typeof huddleReviewEntrySchema>;
export type HuddleRevisionReview = z.infer<typeof huddleRevisionReviewSchema>;
export type HuddleDiffReview = z.infer<typeof huddleDiffReviewSchema>;
export type HuddleReview = z.infer<typeof huddleReviewSchema>;
