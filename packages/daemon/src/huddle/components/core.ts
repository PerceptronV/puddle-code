import { huddleComponentSchema } from '@puddle/shared';

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
  [manualHuddleTrigger, huddleResultReadout].map((component) => [
    `${component.id}@${component.version}`,
    component,
  ]),
);
