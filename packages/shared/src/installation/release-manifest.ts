import { z } from 'zod';

export const releaseVersionSchema = z
  .string()
  .max(64)
  .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
export const releaseComponentSchema = z.enum(['frontend', 'daemon', 'runtime']);
export type ReleaseComponent = z.infer<typeof releaseComponentSchema>;
const canonicalReleaseManifestSchema = z
  .object({
    format: z.literal(2),
    version: releaseVersionSchema,
    components: z
      .object({
        frontend: releaseVersionSchema,
        daemon: releaseVersionSchema,
        runtime: releaseVersionSchema,
      })
      .strict(),
  })
  .strict();
// Published format 1 metadata is immutable; normalize its historical wire key at the boundary.
const legacyReleaseManifestSchema = z
  .object({
    format: z.literal(1),
    version: releaseVersionSchema,
    components: z
      .object({
        cockpit: releaseVersionSchema,
        daemon: releaseVersionSchema,
        runtime: releaseVersionSchema,
      })
      .strict(),
  })
  .strict()
  .transform((manifest) => ({
    format: 2 as const,
    version: manifest.version,
    components: {
      frontend: manifest.components.cockpit,
      daemon: manifest.components.daemon,
      runtime: manifest.components.runtime,
    },
  }));
export const releaseManifestSchema = z
  .union([canonicalReleaseManifestSchema, legacyReleaseManifestSchema])
  .superRefine((manifest, context) => {
    if (
      ![manifest.version, ...Object.values(manifest.components)].every(
        (version) => releaseVersionSchema.safeParse(version).success,
      )
    )
      return;
    for (const [component, version] of Object.entries(manifest.components)) {
      if (compareReleaseVersions(version, manifest.version) > 0)
        context.addIssue({ code: 'custom', message: `${component} points beyond its release` });
    }
    if (manifest.components.frontend !== manifest.version)
      context.addIssue({ code: 'custom', message: 'Every release publishes its frontend' });
  });
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export function compareReleaseVersions(a: string, b: string): number {
  const left = a.split('.').map(BigInt);
  const right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i]! < right[i]!) return -1;
    if (left[i]! > right[i]!) return 1;
  }
  return 0;
}
