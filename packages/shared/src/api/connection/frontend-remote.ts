import { z } from 'zod';
import { profileId } from '../common.js';
import { connectorSetupSchema } from '../../remote/service.js';
import {
  remoteAdminRequestSchema,
  remoteDeviceSchema,
  remoteIdSchema,
  remoteOriginSchema,
  remotePeerSchema,
  remoteSecretSchema,
} from '../../remote/protocol.js';

/** Private host IPC only. Host grants and deletion are absent from remoteAdminRequestSchema. */
export const connectorLocalRequestSchema = z.union([
  remoteAdminRequestSchema,
  z.object({ t: z.literal('delete_registration') }).strict(),
  z.object({ t: z.literal('maintenance'), id: remoteIdSchema, enabled: z.boolean() }).strict(),
]);
export type ConnectorLocalRequest = z.infer<typeof connectorLocalRequestSchema>;

/** Trusted local/SSH frontend controls. Never admitted by the encrypted remote policy. */
export const frontendRemoteRequestSchema = z.union([
  connectorLocalRequestSchema,
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
export type FrontendRemoteRequest = z.infer<typeof frontendRemoteRequestSchema>;

/** Read-only machine-side check; neither consumes the code nor returns a routing credential. */
export const frontendRegistrationCheckSchema = z
  .object({ service: remoteOriginSchema, code: remoteSecretSchema })
  .strict();

/** Deliberately excludes routing credentials, account tokens and host private keys. */
export const frontendRemoteStatusSchema = z.object({
  availability: z.enum(['ready', 'not_installed', 'upgrade_required']),
  configured: z.boolean(),
  enabled: z.boolean(),
  connected: z.boolean(),
  canDeleteRegistration: z.boolean().optional(),
  canManageMaintenance: z.boolean().optional(),
  supervisor: z.enum(['systemd', 'launchd']).nullable(),
  host: remoteIdSchema.optional(),
  peer: remotePeerSchema.optional(),
  service: remoteOriginSchema.optional(),
  app: remoteOriginSchema.optional(),
  devices: z.array(remoteDeviceSchema),
});
export type FrontendRemoteStatus = z.infer<typeof frontendRemoteStatusSchema>;

/** The profile is selected by the trusted local/SSH frontend, never the remote browser. */
export const connectorProfileSchema = z.object({ profile: profileId }).strict();
export const connectorAdminSchema = z
  .object({ profile: profileId, request: connectorLocalRequestSchema })
  .strict();
export const connectorConfigureSchema = z
  .object({ profile: profileId, setup: connectorSetupSchema })
  .strict();
