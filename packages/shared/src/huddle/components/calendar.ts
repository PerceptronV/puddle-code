import { huddleComponentSchema } from '../../api/huddle/components.js';
import { intervalHuddleTrigger } from './interval.js';

export const calendarHuddleTrigger = huddleComponentSchema.parse({
  format: 1,
  id: 'puddle.trigger.calendar',
  version: 1,
  category: 'trigger',
  title: 'Calendar',
  parameters: {
    timeZone: {
      title: 'Timezone',
      description: 'An IANA timezone, such as Europe/London or America/New_York.',
      schema: { type: 'string', minLength: 1, maxLength: 100 },
      editor: 'text',
      default: 'UTC',
    },
    time: {
      title: 'Local time',
      description:
        '24-hour HH:mm. Missing clock times are skipped; repeated times fire once, at the earlier occurrence.',
      schema: { type: 'string', minLength: 5, maxLength: 5 },
      editor: 'text',
      default: '09:00',
    },
    weekdays: {
      title: 'Weekdays',
      description: 'JSON list: Monday is 1, Sunday is 7. Select all seven for a daily schedule.',
      schema: {
        type: 'array',
        items: { type: 'integer', minimum: 1, maximum: 7 },
        minItems: 1,
        maxItems: 7,
      },
      editor: 'json',
      default: [1, 2, 3, 4, 5, 6, 7],
    },
    missed: intervalHuddleTrigger.parameters.missed!,
    maxCatchUp: intervalHuddleTrigger.parameters.maxCatchUp!,
  },
  outputs: intervalHuddleTrigger.outputs,
});

export const dateHuddleTrigger = huddleComponentSchema.parse({
  format: 1,
  id: 'puddle.trigger.date',
  version: 1,
  category: 'trigger',
  title: 'Date and time',
  parameters: {
    at: {
      title: 'Date and time',
      description:
        'ISO date/time with Z or an explicit offset, for example 2027-03-01T09:00:00+01:00. Fires once per applied revision activation.',
      schema: { type: 'string', minLength: 20, maxLength: 35 },
      editor: 'text',
      required: true,
    },
    past: {
      title: 'If already past when armed',
      schema: { type: 'string', enum: ['fire', 'skip'] },
      editor: 'enum',
      default: 'fire',
    },
  },
  outputs: intervalHuddleTrigger.outputs,
});

export const calendarDateHuddleTrigger = huddleComponentSchema.parse({
  format: 1,
  id: 'puddle.trigger.calendar-date',
  version: 1,
  category: 'trigger',
  title: 'Monthly / yearly',
  parameters: {
    timeZone: calendarHuddleTrigger.parameters.timeZone!,
    time: calendarHuddleTrigger.parameters.time!,
    months: {
      title: 'Months',
      description:
        'JSON list: January is 1, December is 12. All months repeats monthly; one month repeats yearly.',
      schema: {
        type: 'array',
        items: { type: 'integer', minimum: 1, maximum: 12 },
        minItems: 1,
        maxItems: 12,
      },
      editor: 'json',
      default: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    },
    day: {
      title: 'Day of month',
      description:
        'Missing dates are skipped, not moved. February 29 fires only in leap years; day 31 skips shorter months.',
      schema: { type: 'integer', minimum: 1, maximum: 31 },
      editor: 'number',
      default: 1,
    },
    missed: intervalHuddleTrigger.parameters.missed!,
    maxCatchUp: intervalHuddleTrigger.parameters.maxCatchUp!,
  },
  outputs: intervalHuddleTrigger.outputs,
});
