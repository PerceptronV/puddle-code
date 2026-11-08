import { z } from 'zod';

const version = z.number().int().positive().max(65535);
/** Each version covers the named complete contract, not a release-number heuristic. */
export const huddleRuntimeCapabilitiesSchema = z.strictObject({
  owner: version,
  definition: version,
  component: version,
  ledger: version,
  operations: version.optional(),
  spawns: version.optional(),
  timers: version.optional(),
  calendar: version.optional(),
  filetree: version.optional(),
  git: version.optional(),
  sessionEvents: version.optional(),
  completionEvents: version.optional(),
  completionPlans: version.optional(),
  readouts: version.optional(),
  readoutObservation: version.optional(),
  customTriggers: version.optional(),
});
export type HuddleRuntimeCapabilities = z.infer<typeof huddleRuntimeCapabilitiesSchema>;
export const HUDDLE_RUNTIME_CAPABILITIES: Readonly<HuddleRuntimeCapabilities> = Object.freeze({
  owner: 1,
  definition: 1,
  component: 1,
  ledger: 1,
  operations: 2,
  spawns: 1,
  timers: 1,
  calendar: 1,
  filetree: 1,
  git: 1,
  sessionEvents: 1,
  completionEvents: 1,
  completionPlans: 1,
  readouts: 1,
  readoutObservation: 1,
  customTriggers: 1,
});

export function supportsHuddleRuntime(value: unknown): value is HuddleRuntimeCapabilities {
  const parsed = huddleRuntimeCapabilitiesSchema.safeParse(value);
  return (
    parsed.success &&
    (['owner', 'definition', 'component', 'ledger'] as const).every(
      (key) => parsed.data[key] === HUDDLE_RUNTIME_CAPABILITIES[key],
    ) &&
    (parsed.data.operations === undefined || [1, 2].includes(parsed.data.operations)) &&
    (parsed.data.spawns === undefined ||
      (parsed.data.spawns === 1 && parsed.data.operations === 2)) &&
    (parsed.data.timers === undefined || parsed.data.timers === 1) &&
    (parsed.data.calendar === undefined || parsed.data.calendar === 1) &&
    (parsed.data.filetree === undefined || parsed.data.filetree === 1) &&
    (parsed.data.git === undefined || parsed.data.git === 1) &&
    (parsed.data.sessionEvents === undefined || parsed.data.sessionEvents === 1) &&
    (parsed.data.completionEvents === undefined || parsed.data.completionEvents === 1) &&
    (parsed.data.completionPlans === undefined || parsed.data.completionPlans === 1) &&
    (parsed.data.customTriggers === undefined || parsed.data.customTriggers === 1) &&
    (parsed.data.readouts === undefined || parsed.data.readouts === 1) &&
    (parsed.data.readoutObservation === undefined ||
      (parsed.data.readoutObservation === 1 && parsed.data.readouts === 1))
  );
}
