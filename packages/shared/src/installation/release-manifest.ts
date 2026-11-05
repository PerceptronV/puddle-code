import { z } from 'zod';

export const releaseVersionSchema = z
  .string()
  .max(64)
  .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
export const releaseComponentSchema = z.enum(['cockpit', 'daemon', 'runtime']);
export type ReleaseComponent = z.infer<typeof releaseComponentSchema>;
export const releaseManifestSchema = z
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
    if (manifest.components.cockpit !== manifest.version)
      context.addIssue({ code: 'custom', message: 'Every release publishes its cockpit' });
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
