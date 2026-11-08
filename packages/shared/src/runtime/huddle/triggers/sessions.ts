import { z } from 'zod';
import { sessionId } from '../../../api/common.js';
import { sessionStatusSchema } from '../../../api/agents/sessions.js';
import { huddleKeySchema } from '../../../api/huddle/values.js';
import { huddleRevisionSchema } from '../../../api/huddle/events.js';
import {
  huddleSessionFeedCursorSchema,
  huddleSessionFeedEventSchema,
  huddleSessionFeedScopeSchema,
} from './session-feed.js';

export const HUDDLE_SESSION_SOURCE_LIMIT = 8;
export const huddleSessionSettingsSchema = z.strictObject({
  worktree: z.string().min(1).max(4096),
  session: sessionId.optional(),
  kinds: z
    .array(z.enum(['agent', 'terminal']))
    .min(1)
    .max(2),
  events: z.array(huddleSessionFeedEventSchema).min(1).max(9),
  statuses: z.array(sessionStatusSchema).min(1).max(6),
});
export const huddleSessionSourceSchema = z.strictObject({
  slot: z
    .number()
    .int()
    .min(0)
    .max(HUDDLE_SESSION_SOURCE_LIMIT - 1),
  node: huddleKeySchema,
  activationId: z.uuid(),
  revision: huddleRevisionSchema,
  generation: z.number().int().nonnegative().safe(),
  scope: huddleSessionFeedScopeSchema,
  statuses: huddleSessionSettingsSchema.shape.statuses,
  cursor: huddleSessionFeedCursorSchema,
});
export type HuddleSessionSource = z.infer<typeof huddleSessionSourceSchema>;
