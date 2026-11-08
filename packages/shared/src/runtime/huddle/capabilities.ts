import { z } from 'zod';

const version = z.number().int().positive().max(65535);
/** Each version covers the named complete contract, not a release-number heuristic. */
export const huddleRuntimeCapabilitiesSchema = z.strictObject({
  owner: version,
  definition: version,
  component: version,
  ledger: version,
});
export type HuddleRuntimeCapabilities = z.infer<typeof huddleRuntimeCapabilitiesSchema>;
export const HUDDLE_RUNTIME_CAPABILITIES: Readonly<HuddleRuntimeCapabilities> = Object.freeze({
  owner: 1,
  definition: 1,
  component: 1,
  ledger: 1,
});

export function supportsHuddleRuntime(value: unknown): value is HuddleRuntimeCapabilities {
  const parsed = huddleRuntimeCapabilitiesSchema.safeParse(value);
  return (
    parsed.success &&
    Object.entries(HUDDLE_RUNTIME_CAPABILITIES).every(
      ([key, version]) => parsed.data[key as keyof HuddleRuntimeCapabilities] === version,
    )
  );
}
