import { z } from 'zod';

const version = z.number().int().positive().max(65535);
/** Each version covers the named complete contract, not a release-number heuristic. */
export const huddleRuntimeCapabilitiesSchema = z.strictObject({
  owner: version,
  definition: version,
  component: version,
  ledger: version,
  operations: version.optional(),
  timers: version.optional(),
  calendar: version.optional(),
});
export type HuddleRuntimeCapabilities = z.infer<typeof huddleRuntimeCapabilitiesSchema>;
export const HUDDLE_RUNTIME_CAPABILITIES: Readonly<HuddleRuntimeCapabilities> = Object.freeze({
  owner: 1,
  definition: 1,
  component: 1,
  ledger: 1,
  operations: 2,
  timers: 1,
  calendar: 1,
});

export function supportsHuddleRuntime(value: unknown): value is HuddleRuntimeCapabilities {
  const parsed = huddleRuntimeCapabilitiesSchema.safeParse(value);
  return (
    parsed.success &&
    (['owner', 'definition', 'component', 'ledger'] as const).every(
      (key) => parsed.data[key] === HUDDLE_RUNTIME_CAPABILITIES[key],
    ) &&
    (parsed.data.operations === undefined || [1, 2].includes(parsed.data.operations)) &&
    (parsed.data.timers === undefined || parsed.data.timers === 1) &&
    (parsed.data.calendar === undefined || parsed.data.calendar === 1)
  );
}
