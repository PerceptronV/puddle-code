import { z } from 'zod';
import { connectorInspectionResponseSchema } from '../api/connection/connector-inspection.js';
import { hostServiceReplacementSchema } from './supervision.js';

/** Private approved replacement evidence, without profile configuration or credentials. */
export const hostConnectorReplacementSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('absent') }).strict(),
  z
    .object({
      state: z.literal('running'),
      identity: connectorInspectionResponseSchema.omit({ t: true, nonce: true }).extend({
        ready: z.literal(true),
      }),
      service: hostServiceReplacementSchema.refine((service) => service.component === 'connector'),
    })
    .strict()
    .refine(
      (value) => value.identity.pid === value.service.pid,
      'Connector service PID does not match its process',
    ),
]);
export type HostConnectorReplacement = z.infer<typeof hostConnectorReplacementSchema>;
