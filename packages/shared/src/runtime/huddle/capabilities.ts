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
  lifecycle: version.optional(),
  recovery: version.optional(),
  crashRecovery: version.optional(),
  coalitionRecovery: version.optional(),
  automaticRecovery: version.optional(),
  autoStart: version.optional(),
  triggerInspection: version.optional(),
  executionInputs: version.optional(),
  admission: version.optional(),
  timers: version.optional(),
  calendar: version.optional(),
  filetree: version.optional(),
  git: version.optional(),
  sessionEvents: version.optional(),
  completionEvents: version.optional(),
  completionPlans: version.optional(),
  nativeFeedback: version.optional(),
  integrationSecrets: version.optional(),
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
  lifecycle: 1,
  recovery: 1,
  crashRecovery: 1,
  coalitionRecovery: 1,
  automaticRecovery: 1,
  autoStart: 1,
  triggerInspection: 1,
  executionInputs: 1,
  admission: 1,
  timers: 1,
  calendar: 2,
  filetree: 1,
  git: 1,
  sessionEvents: 1,
  completionEvents: 1,
  completionPlans: 1,
  nativeFeedback: 1,
  integrationSecrets: 1,
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
    (parsed.data.lifecycle === undefined ||
      (parsed.data.lifecycle === 1 && parsed.data.spawns === 1 && parsed.data.operations === 2)) &&
    (parsed.data.triggerInspection === undefined || parsed.data.triggerInspection === 1) &&
    (parsed.data.automaticRecovery === undefined ||
      (parsed.data.automaticRecovery === 1 && parsed.data.crashRecovery === 1)) &&
    (parsed.data.coalitionRecovery === undefined ||
      (parsed.data.coalitionRecovery === 1 && parsed.data.crashRecovery === 1)) &&
    (parsed.data.crashRecovery === undefined ||
      (parsed.data.crashRecovery === 1 && parsed.data.recovery === 1)) &&
    (parsed.data.recovery === undefined || parsed.data.recovery === 1) &&
    (parsed.data.autoStart === undefined ||
      (parsed.data.autoStart === 1 && parsed.data.recovery === 1)) &&
    (parsed.data.executionInputs === undefined || parsed.data.executionInputs === 1) &&
    (parsed.data.admission === undefined || parsed.data.admission === 1) &&
    (parsed.data.timers === undefined || parsed.data.timers === 1) &&
    (parsed.data.calendar === undefined || [1, 2].includes(parsed.data.calendar)) &&
    (parsed.data.filetree === undefined || parsed.data.filetree === 1) &&
    (parsed.data.git === undefined || parsed.data.git === 1) &&
    (parsed.data.sessionEvents === undefined || parsed.data.sessionEvents === 1) &&
    (parsed.data.completionEvents === undefined || parsed.data.completionEvents === 1) &&
    (parsed.data.integrationSecrets === undefined || parsed.data.integrationSecrets === 1) &&
    (parsed.data.nativeFeedback === undefined ||
      (parsed.data.nativeFeedback === 1 &&
        parsed.data.operations === 2 &&
        parsed.data.completionEvents === 1 &&
        parsed.data.completionPlans === 1)) &&
    (parsed.data.completionPlans === undefined || parsed.data.completionPlans === 1) &&
    (parsed.data.customTriggers === undefined || parsed.data.customTriggers === 1) &&
    (parsed.data.readouts === undefined || parsed.data.readouts === 1) &&
    (parsed.data.readoutObservation === undefined ||
      (parsed.data.readoutObservation === 1 && parsed.data.readouts === 1))
  );
}
