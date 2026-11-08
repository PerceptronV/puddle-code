import { z } from 'zod';
import { PROTOCOL_VERSION } from '../protocol.js';
import { hostStageRecordSchema } from './stage.js';
import {
  HUDDLE_RUNTIME_CAPABILITIES,
  huddleRuntimeCapabilitiesSchema,
  type HuddleRuntimeCapabilities,
} from '../runtime/huddle/capabilities.js';

/** Separate passive metadata: runtime execution support does not imply daemon adoption support. */
export const daemonRuntimeCapabilitiesSchema = z.strictObject({
  format: z.literal(1),
  version: z.string().min(1).max(128),
  application: hostStageRecordSchema.shape.protocol,
  roles: z.strictObject({ huddle: huddleRuntimeCapabilitiesSchema.optional() }),
});
export type DaemonRuntimeCapabilities = z.infer<typeof daemonRuntimeCapabilitiesSchema>;

export function daemonRuntimeCapabilities(version: string): DaemonRuntimeCapabilities {
  return daemonRuntimeCapabilitiesSchema.parse({
    format: 1,
    version,
    application: PROTOCOL_VERSION,
    roles: { huddle: HUDDLE_RUNTIME_CAPABILITIES },
  });
}

export function canAdoptHuddle(
  candidate: DaemonRuntimeCapabilities | null | undefined,
  required: HuddleRuntimeCapabilities,
): boolean {
  const supported = candidate?.roles.huddle;
  return (
    !!supported &&
    Object.entries(required).every(
      ([key, version]) => supported[key as keyof HuddleRuntimeCapabilities] === version,
    )
  );
}
