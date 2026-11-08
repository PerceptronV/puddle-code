import { intervalHuddleTrigger } from './interval.js';
import { calendarHuddleTrigger, dateHuddleTrigger } from './calendar.js';
import { filetreeHuddleTrigger } from './filetree.js';
import { sessionHuddleTrigger } from './session.js';
import { completionHuddleTrigger } from './completion.js';
import { gitHuddleTrigger } from './git.js';
import { huddleComponentSchema } from '../../api/huddle/components.js';

export const manualHuddleTrigger = huddleComponentSchema.parse({
  format: 1,
  id: 'puddle.trigger.manual',
  version: 1,
  category: 'trigger',
  title: 'Run',
  outputs: { event: { schema: {}, emission: 'event' } },
});
export const huddleResultReadout = huddleComponentSchema.parse({
  format: 1,
  id: 'puddle.readout.result',
  version: 1,
  category: 'readout',
  title: 'Result',
  inputs: { value: { schema: {} } },
});
/** Built-ins use the same portable contracts as project-local components. */
export const coreHuddleComponents = new Map(
  [
    manualHuddleTrigger,
    huddleResultReadout,
    intervalHuddleTrigger,
    calendarHuddleTrigger,
    dateHuddleTrigger,
    filetreeHuddleTrigger,
    gitHuddleTrigger,
    sessionHuddleTrigger,
    completionHuddleTrigger,
  ].map((component) => [`${component.id}@${component.version}`, component]),
);
