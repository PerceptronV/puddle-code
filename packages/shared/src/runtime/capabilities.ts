import { z } from 'zod';
import { RUNTIME_PROTOCOL_VERSION } from './protocol.js';
import {
  HUDDLE_RUNTIME_CAPABILITIES,
  huddleRuntimeCapabilitiesSchema,
} from './huddle/capabilities.js';

/** Separate passive file: historical HOST_CAPABILITIES readers retain their closed schema. */
export const runtimeReleaseCapabilitiesSchema = z.strictObject({
  format: z.literal(1),
  version: z.string().min(1).max(128),
  protocol: z.strictObject({
    major: z.number().int().nonnegative().safe(),
    minor: z.number().int().nonnegative().safe(),
  }),
  roles: z.strictObject({ huddle: huddleRuntimeCapabilitiesSchema.optional() }),
});
export type RuntimeReleaseCapabilities = z.infer<typeof runtimeReleaseCapabilitiesSchema>;
export function runtimeReleaseCapabilities(version: string): RuntimeReleaseCapabilities {
  return runtimeReleaseCapabilitiesSchema.parse({
    format: 1,
    version,
    protocol: RUNTIME_PROTOCOL_VERSION,
    roles: { huddle: HUDDLE_RUNTIME_CAPABILITIES },
  });
}
