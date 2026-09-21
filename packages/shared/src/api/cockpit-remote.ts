import { z } from 'zod';
import {
  remoteAdminRequestSchema,
  remoteDeviceSchema,
  remoteIdSchema,
  remoteOriginSchema,
  remotePeerSchema,
  remoteSecretSchema,
} from '../remote/protocol.js';

/** Trusted local/SSH cockpit controls. Never admitted by the encrypted remote policy. */
export const cockpitRemoteRequestSchema = z.union([
  remoteAdminRequestSchema,
  z
    .object({
      t: z.literal('enable'),
      registration: z
        .object({ service: remoteOriginSchema, app: remoteOriginSchema, code: remoteSecretSchema })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ t: z.literal('reset') }).strict(),
]);
export type CockpitRemoteRequest = z.infer<typeof cockpitRemoteRequestSchema>;

/** Deliberately excludes routing credentials, account tokens and host private keys. */
export const cockpitRemoteStatusSchema = z.object({
  availability: z.enum(['ready', 'not_installed', 'upgrade_required']),
  configured: z.boolean(),
  enabled: z.boolean(),
  connected: z.boolean(),
  supervisor: z.enum(['systemd', 'launchd']).nullable(),
  host: remoteIdSchema.optional(),
  peer: remotePeerSchema.optional(),
  service: remoteOriginSchema.optional(),
  app: remoteOriginSchema.optional(),
  devices: z.array(remoteDeviceSchema),
});
export type CockpitRemoteStatus = z.infer<typeof cockpitRemoteStatusSchema>;
