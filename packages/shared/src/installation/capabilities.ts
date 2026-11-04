import { z } from 'zod';
import { PROTOCOL_VERSION } from '../protocol.js';
import { REMOTE_PROTOCOL_VERSION } from '../remote/protocol.js';
import { RUNTIME_PROTOCOL_VERSION } from '../runtime/protocol.js';
import { hostStageRecordSchema } from './stage.js';

/** Runtime-major support covers both live IPC and retained runtime state. */
export const SUPPORTED_RUNTIME_MAJORS: readonly number[] = [RUNTIME_PROTOCOL_VERSION.major];

/** Passive release metadata; no separate storage compatibility contract. */
export const hostReleaseCapabilitiesSchema = z
  .object({
    format: z.literal(1),
    version: z.string().min(1).max(128),
    application: hostStageRecordSchema.shape.protocol,
    remote: z.number().int().nonnegative().safe(),
    runtime: hostStageRecordSchema.shape.protocol,
    supported_runtime_majors: z
      .array(z.number().int().nonnegative().safe())
      .min(1)
      .max(16)
      .refine((values) => new Set(values).size === values.length),
    /** Existing SQLite migration ceiling, not another protocol or rollback permission. */
    database_schema_version: z
      .number()
      .int()
      .nonnegative()
      .max(2 ** 31 - 1)
      .optional(),
  })
  .strict();
export type HostReleaseCapabilities = z.infer<typeof hostReleaseCapabilitiesSchema>;

export function hostReleaseCapabilities(
  version: string,
  databaseSchemaVersion?: number,
): HostReleaseCapabilities {
  return hostReleaseCapabilitiesSchema.parse({
    format: 1,
    version,
    application: PROTOCOL_VERSION,
    remote: REMOTE_PROTOCOL_VERSION,
    runtime: RUNTIME_PROTOCOL_VERSION,
    supported_runtime_majors: SUPPORTED_RUNTIME_MAJORS,
    ...(databaseSchemaVersion !== undefined
      ? { database_schema_version: databaseSchemaVersion }
      : {}),
  });
}
