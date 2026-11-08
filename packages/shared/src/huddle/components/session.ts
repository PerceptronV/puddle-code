import { huddleComponentSchema } from '../../api/huddle/components.js';
import { sessionStatusSchema } from '../../api/agents/sessions.js';
import { huddleSessionFeedEventSchema } from '../../runtime/huddle/triggers/session-feed.js';

export const sessionHuddleTrigger = huddleComponentSchema.parse({
  format: 1,
  id: 'puddle.trigger.session',
  version: 1,
  category: 'trigger',
  title: 'Session lifecycle',
  capabilities: ['sessions'],
  description:
    'Observe Puddle lifecycle records and status changes. Status is not exact turn completion.',
  parameters: {
    worktree: { title: 'Worktree', schema: { type: 'string' }, editor: 'worktree' },
    session: {
      title: 'Session',
      description: 'Optional. Leave unset to observe matching sessions in this worktree.',
      schema: { type: 'string', minLength: 1 },
      editor: 'session',
      required: false,
    },
    kinds: {
      title: 'Session kinds',
      schema: {
        type: 'array',
        items: { type: 'string', enum: ['agent', 'terminal'] },
        minItems: 1,
        maxItems: 2,
      },
      editor: 'json',
      default: ['agent'],
    },
    events: {
      title: 'Events',
      schema: {
        type: 'array',
        items: { type: 'string', enum: huddleSessionFeedEventSchema.options },
        minItems: 1,
        maxItems: 9,
      },
      editor: 'json',
      default: ['resumed', 'exited', 'archived'],
    },
    statuses: {
      title: 'Status transitions to',
      description:
        'Applies only when Events includes status. Waiting for input does not prove a completed turn.',
      schema: {
        type: 'array',
        items: { type: 'string', enum: sessionStatusSchema.options },
        minItems: 1,
        maxItems: 6,
      },
      editor: 'json',
      default: sessionStatusSchema.options,
    },
  },
  outputs: {
    event: {
      emission: 'event',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sequence: { type: 'integer', minimum: 1 },
          profileId: { type: 'string' },
          projectId: { type: 'string' },
          sessionId: { type: 'string' },
          worktree: { type: 'string' },
          sessionKind: { type: 'string', enum: ['agent', 'terminal'] },
          event: { type: 'string', enum: huddleSessionFeedEventSchema.options },
          source: { type: 'string', enum: ['placement', 'status', 'audit'] },
          previousStatus: { type: ['string', 'null'] },
          status: { type: 'string', enum: sessionStatusSchema.options },
          observedAt: { type: 'string' },
        },
        required: [
          'sequence',
          'profileId',
          'projectId',
          'sessionId',
          'worktree',
          'sessionKind',
          'event',
          'source',
          'previousStatus',
          'status',
          'observedAt',
        ],
      },
    },
  },
});
