import { z } from 'zod';
import { isoTimestamp, profileId, projectId, sessionId } from '../../../api/common.js';
import { sessionKindSchema, sessionStatusSchema } from '../../../api/agents/sessions.js';

/** Host observations, not native turn completions or permission to dispatch work. */
export const huddleSessionFeedEventSchema = z.enum([
  'created',
  'resumed',
  'interrupted',
  'exited',
  'killed',
  'archived',
  'unarchived',
  'spawn_failed',
  'status',
]);
export const HUDDLE_SESSION_FEED_LIMITS = {
  records: 4096,
  rowBytes: 8192,
  page: 64,
  pageBytes: 128 * 1024,
} as const;
const sequence = z.number().int().nonnegative().safe();
export const huddleSessionFeedCursorSchema = z.strictObject({
  epoch: z.string().regex(/^[a-f0-9]{32}$/),
  sequence,
});
export type HuddleSessionFeedCursor = z.infer<typeof huddleSessionFeedCursorSchema>;
export const huddleSessionFeedScopeSchema = z.strictObject({
  profileId,
  projectId,
  worktree: z.string().min(1).max(4096),
  sessionId: sessionId.optional(),
  kinds: z.array(sessionKindSchema).min(1).max(3),
  events: z.array(huddleSessionFeedEventSchema).min(1).max(9),
  excludeSessionId: sessionId.optional(),
});
export type HuddleSessionFeedScope = z.infer<typeof huddleSessionFeedScopeSchema>;
export const huddleSessionFeedRecordSchema = z
  .strictObject({
    sequence: sequence.refine((value) => value > 0),
    profileId,
    projectId,
    sessionId,
    worktree: z.string().min(1).max(4096),
    sessionKind: sessionKindSchema,
    event: huddleSessionFeedEventSchema,
    source: z.enum(['placement', 'audit', 'status']),
    previousStatus: sessionStatusSchema.nullable(),
    status: sessionStatusSchema,
    observedAt: isoTimestamp,
  })
  .superRefine((value, ctx) => {
    if (
      (value.event === 'created') !== (value.source === 'placement') ||
      (value.event === 'status') !== (value.source === 'status') ||
      (value.event === 'status'
        ? value.previousStatus === null || value.previousStatus === value.status
        : value.previousStatus !== null)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Session observation provenance does not match its event',
      });
    if (
      new TextEncoder().encode(JSON.stringify(value)).length > HUDDLE_SESSION_FEED_LIMITS.rowBytes
    )
      ctx.addIssue({ code: 'custom', message: 'Session observation exceeds its byte limit' });
  });
export type HuddleSessionFeedRecord = z.infer<typeof huddleSessionFeedRecordSchema>;
export const huddleSessionFeedPageSchema = z
  .discriminatedUnion('state', [
    z.strictObject({ state: z.literal('baseline'), cursor: huddleSessionFeedCursorSchema }),
    z.strictObject({
      state: z.literal('gap'),
      cursor: huddleSessionFeedCursorSchema,
      floor: sequence,
      reason: z.enum(['epoch', 'retention', 'ahead']),
    }),
    z.strictObject({
      state: z.literal('events'),
      cursor: huddleSessionFeedCursorSchema,
      head: sequence,
      records: z.array(huddleSessionFeedRecordSchema).max(HUDDLE_SESSION_FEED_LIMITS.page),
    }),
  ])
  .superRefine((value, ctx) => {
    if (
      new TextEncoder().encode(JSON.stringify(value)).length > HUDDLE_SESSION_FEED_LIMITS.pageBytes
    )
      ctx.addIssue({ code: 'custom', message: 'Session observation page exceeds its byte limit' });
    if (
      value.state === 'events' &&
      (value.cursor.sequence > value.head ||
        value.records.some(
          (record, i) =>
            record.sequence > value.cursor.sequence ||
            (i > 0 && record.sequence <= value.records[i - 1]!.sequence),
        ))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Session observation page is not ordered within its checkpoint',
      });
    if (value.state === 'gap' && value.floor > value.cursor.sequence)
      ctx.addIssue({ code: 'custom', message: 'Session observation floor exceeds its head' });
  });
export type HuddleSessionFeedPage = z.infer<typeof huddleSessionFeedPageSchema>;
