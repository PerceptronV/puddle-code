import {
  calendarHuddleTrigger,
  calendarDateHuddleTrigger,
  dateHuddleTrigger,
  HUDDLE_CALENDAR_LIMIT,
  huddleCalendarSettingsSchema,
  huddleCalendarDateSettingsSchema,
  huddleDateSettingsSchema,
  huddleHostTrigger,
  resolveHuddleHostParameters,
  type HuddleRevisionActivation,
} from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from '../../../../huddle/definitions/capture.js';
import { requireCalendarTimezone } from './occurrences.js';

export function scheduleDefinitions(
  snapshot: HuddleDefinitionSnapshot,
  activation: HuddleRevisionActivation,
) {
  const nodes = snapshot.definition.nodes.filter((node) =>
    [calendarHuddleTrigger.id, calendarDateHuddleTrigger.id, dateHuddleTrigger.id].includes(
      huddleHostTrigger(node, snapshot.components[node.id])?.id ?? '',
    ),
  );
  if (nodes.length > HUDDLE_CALENDAR_LIMIT)
    throw new Error(`A huddle supports at most ${HUDDLE_CALENDAR_LIMIT} calendar/date triggers`);
  return nodes.map((node) => {
    const parameters = resolveHuddleHostParameters(
      snapshot.definition,
      node,
      snapshot.components[node.id]!,
      activation.variables,
    );
    if (
      huddleHostTrigger(node, snapshot.components[node.id])?.id === calendarDateHuddleTrigger.id
    ) {
      const settings = huddleCalendarDateSettingsSchema.parse(parameters);
      requireCalendarTimezone(settings.timeZone);
      return { node: node.id, kind: 'calendar-date' as const, ...settings };
    }
    if (huddleHostTrigger(node, snapshot.components[node.id])?.id === calendarHuddleTrigger.id) {
      const settings = huddleCalendarSettingsSchema.parse(parameters);
      requireCalendarTimezone(settings.timeZone);
      return { node: node.id, kind: 'calendar' as const, ...settings };
    }
    const settings = huddleDateSettingsSchema.parse(parameters);
    const due = Date.parse(settings.at);
    if (!Number.isSafeInteger(due) || due < 0)
      throw new Error('Date trigger requires an instant on or after 1970-01-01');
    return { node: node.id, kind: 'date' as const, ...settings, due };
  });
}
