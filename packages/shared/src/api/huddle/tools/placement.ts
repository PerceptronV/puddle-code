import { z } from 'zod';
import { sessionId } from '../../common.js';
import { sessionSchema } from '../../agents/sessions.js';
import { huddleIdSchema } from '../values.js';

export const huddleToolPlacementSchema = z.strictObject({ session_id: sessionId });
export const huddleToolPlacementCommandSchema = huddleToolPlacementSchema.extend({
  action: z.enum(['session', 'archive', 'unarchive']),
});
export type HuddleToolPlacementCommand = z.infer<typeof huddleToolPlacementCommandSchema>;
export const huddleToolSessionSchema = sessionSchema.extend({
  kind: z.literal('huddle'),
  huddle_id: huddleIdSchema,
});

export const huddlePlacementMcpTools = [
  {
    action: 'session',
    description:
      'Inspect a huddle session placement in the selected profile, including its archive status and declared project/worktree. Does not start or unarchive it.',
  },
  {
    action: 'archive',
    description:
      'Archive this huddle placement using normal session lifecycle controls. Stops its current owner and applies captured agent cleanup policy before hiding it; preserves source, worktree and history. This targets the placement, not a previously inspected runtime incarnation. After any failed reply inspect huddle_session and huddle_runtime; never retry automatically.',
  },
  {
    action: 'unarchive',
    description:
      'Restore an archived huddle placement to the stopped session list. Does not start an owner, arm triggers, recreate a missing worktree or unarchive its project. After any failed reply inspect huddle_session; never retry automatically.',
  },
].map(({ action, description }) => ({
  name: `huddle_${action}`,
  action,
  description,
  inputSchema: z.toJSONSchema(huddleToolPlacementSchema, { io: 'input' }),
  annotations: {
    readOnlyHint: action === 'session',
    destructiveHint: action === 'archive',
    idempotentHint: action === 'session',
    openWorldHint: action === 'archive',
  },
}));
