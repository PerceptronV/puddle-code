import { z } from 'zod';

/** Private update evidence; service configuration and its environment stay on the host. */
export const hostServiceReplacementSchema = z
  .object({
    kind: z.enum(['systemd', 'launchd']),
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
    domain: z
      .string()
      .regex(/^gui\/\d+$/)
      .nullable(),
    pid: z.number().int().positive().safe(),
    invocation: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .nullable(),
    controlGroup: z.string().min(1).max(4096).nullable(),
    definition_path: z.string().min(1).max(4096).nullable(),
    definition_digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .refine(
    (service) =>
      service.kind === 'systemd'
        ? service.name.endsWith('.service') &&
          service.domain === null &&
          service.invocation !== null &&
          service.controlGroup !== null &&
          service.definition_path === null
        : service.domain !== null &&
          service.invocation === null &&
          service.controlGroup === null &&
          service.definition_path !== null,
    'Inconsistent service replacement evidence',
  );
export type HostServiceReplacement = z.infer<typeof hostServiceReplacementSchema>;
