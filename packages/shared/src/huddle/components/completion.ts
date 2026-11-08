import { huddleComponentSchema } from '../../api/huddle/components.js';

/** Not in the creation catalogue until host admission and dispatch are connected. */
export const completionHuddleTrigger = huddleComponentSchema.parse({
  format: 1,
  id: 'puddle.trigger.turn-completed',
  version: 1,
  category: 'trigger',
  title: 'Turn completed',
  capabilities: ['sessions'],
  description:
    'Observe exact completed external turns in a selected agent. Automated and unknown-origin turns are suppressed.',
  parameters: {
    worktree: { title: 'Worktree', schema: { type: 'string' }, editor: 'worktree' },
    session: { title: 'Agent', schema: { type: 'string' }, editor: 'session' },
  },
  outputs: {
    event: {
      emission: 'event',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sequence: { type: 'integer', minimum: 1 },
          event: { type: 'string', enum: ['completed'] },
          observedAt: { type: 'string' },
          sessionId: { type: 'string' },
          runtimeId: { type: 'string' },
          segmentId: { type: 'string' },
          worktree: { type: 'string' },
          agentSessionRef: { type: 'string' },
          nativeTurnId: { type: 'string' },
          reply: { type: 'string' },
          origin: {
            type: 'object',
            additionalProperties: false,
            properties: { kind: { type: 'string', enum: ['external'] } },
            required: ['kind'],
          },
        },
        required: [
          'sequence',
          'event',
          'observedAt',
          'sessionId',
          'runtimeId',
          'segmentId',
          'worktree',
          'agentSessionRef',
          'nativeTurnId',
          'reply',
          'origin',
        ],
      },
    },
  },
});
