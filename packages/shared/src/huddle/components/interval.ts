import { huddleComponentSchema } from '../../api/huddle/components.js';

export const intervalHuddleTrigger = huddleComponentSchema.parse({
  format: 1,
  id: 'puddle.trigger.interval',
  version: 1,
  category: 'trigger',
  title: 'Interval',
  parameters: {
    intervalMs: {
      title: 'Interval (milliseconds)',
      schema: { type: 'integer', minimum: 1000, maximum: 86400000 },
      editor: 'duration',
      default: 60000,
    },
    missed: {
      title: 'Missed occurrences',
      schema: { type: 'string', enum: ['coalesce', 'skip', 'catch-up'] },
      editor: 'enum',
      default: 'coalesce',
    },
    maxCatchUp: {
      title: 'Catch-up limit',
      schema: { type: 'integer', minimum: 1, maximum: 64 },
      editor: 'number',
      default: 10,
    },
  },
  outputs: {
    event: {
      emission: 'event',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scheduledAt: { type: 'string' },
          firstScheduledAt: { type: 'string' },
          occurrences: { type: 'integer', minimum: 1 },
          skipped: { type: 'integer', minimum: 0 },
        },
        required: ['scheduledAt', 'firstScheduledAt', 'occurrences', 'skipped'],
      },
    },
  },
});
