import { z } from 'zod';
import { hostStageRecordSchema } from './stage.js';

export const releaseRepositorySchema = z
  .string()
  .max(201)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/)
  .refine((value) => !['.', '..'].includes(value.split('/')[1]!));
const availableRelease = z
  .object({
    version: z
      .string()
      .max(64)
      .regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    host_asset: z.boolean(),
  })
  .strict();
const timestamp = z.number().int().nonnegative().safe();
export const hostReleaseCheckSchema = z
  .object({
    repository: releaseRepositorySchema.nullable(),
    state: z.enum(['unconfigured', 'checking', 'ready', 'failed']),
    components: z
      .object({ daemon: availableRelease, runtime: availableRelease })
      .strict()
      .optional(),
    checked_at: timestamp.nullable(),
    succeeded_at: timestamp.nullable(),
    latest: z
      .object({
        version: z
          .string()
          .max(128)
          .regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
        host_asset: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const component = z.object({
  version: z.string().min(1).max(128),
  protocol: hostStageRecordSchema.shape.protocol,
});
const count = z.number().int().nonnegative().max(4096);
/** Host-wide public inventory; never includes runtime ids, placements, paths or process details. */
export const hostUpdateCatalogueSchema = z
  .object({
    observed_at: timestamp,
    daemon_version: z.string().min(1).max(128),
    runtime_default: component.strict().nullable(),
    runtimes: z
      .object({
        complete: z.boolean(),
        versions: z
          .array(component.extend({ running: count, starting: count, unavailable: count }).strict())
          .max(128),
      })
      .strict(),
    releases: hostReleaseCheckSchema,
  })
  .strict();
export type HostReleaseCheck = z.infer<typeof hostReleaseCheckSchema>;
export type HostUpdateCatalogue = z.infer<typeof hostUpdateCatalogueSchema>;

/** Old peers receive precisely their original strict schema and no misleading unified offer. */
export function presentHostCatalogue(
  catalogue: HostUpdateCatalogue,
  components = false,
): HostUpdateCatalogue {
  if (components || !catalogue.releases.components) return catalogue;
  const { components: targets, ...releases } = catalogue.releases;
  return {
    ...catalogue,
    releases: {
      ...releases,
      latest: releases.latest && {
        ...releases.latest,
        host_asset:
          targets.daemon.version === releases.latest.version &&
          targets.runtime.version === releases.latest.version &&
          targets.daemon.host_asset &&
          targets.runtime.host_asset,
      },
    },
  };
}
