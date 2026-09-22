import { z } from 'zod';
import {
  REMOTE_PROTOCOL_VERSION,
  remoteAccountSchema,
  remoteIdSchema,
  remoteLabelSchema,
  remoteOriginSchema,
  remotePeerSchema,
  remoteSecretSchema,
} from './protocol.js';

export const remoteHostSchema = z.object({
  id: remoteIdSchema,
  label: remoteLabelSchema,
  online: z.boolean(),
});
export const remoteHostsSchema = z.array(remoteHostSchema);
export type RemoteHost = z.infer<typeof remoteHostSchema>;
export const remoteServiceInfoSchema = z.object({
  providers: z.array(z.enum(['google', 'github'])),
  protocol: z.literal(REMOTE_PROTOCOL_VERSION),
});
export const remoteLoginStateSchema = z.object({
  user: z
    .object({
      id: remoteAccountSchema,
      name: z.string(),
      email: z.string(),
      emailVerified: z.boolean(),
      twoFactorEnabled: z.boolean(),
    })
    .nullable(),
  mfaRequired: z.boolean(),
});
export const registerHostRequestSchema = z.object({ label: remoteLabelSchema }).strict();
export const registrationResponseSchema = z
  .object({ host: remoteIdSchema, code: remoteSecretSchema, expires: z.number() })
  .strict();
export const redeemRegistrationSchema = z.object({ code: remoteSecretSchema }).strict();
/** Retire only the routing record identified by this host's existing credential. */
export const unregisterHostRequestSchema = z.object({ credential: remoteSecretSchema }).strict();
/** Public browser handoff. The secret whose SHA-256 hash is challenge stays in the cockpit. */
export const desktopRegistrationSchema = z
  .object({
    challenge: remoteSecretSchema,
    label: remoteLabelSchema,
    service: remoteOriginSchema,
    app: remoteOriginSchema,
    expires: z.number().int().positive(),
  })
  .strict();
export type DesktopRegistration = z.infer<typeof desktopRegistrationSchema>;
export const registrationStatusSchema = z.object({ ready: z.boolean() }).strict();
export const connectorRegistrationSchema = z
  .object({
    host: remoteIdSchema,
    account: remoteAccountSchema,
    credential: remoteSecretSchema,
  })
  .strict();
export const connectorConfigSchema = connectorRegistrationSchema
  .extend({
    service: remoteOriginSchema,
    app: remoteOriginSchema,
    enabled: z.boolean(),
  })
  .strict();
export type ConnectorConfig = z.infer<typeof connectorConfigSchema>;
export const connectorSetupSchema = z
  .object({
    service: remoteOriginSchema.optional(),
    app: remoteOriginSchema.optional(),
    code: remoteSecretSchema.optional(),
    managed: z.boolean().default(true),
  })
  .strict();
export const remoteIdentitySchema = z.array(z.number().int().min(0).max(255)).min(32).max(256);
export const remoteBrowserHostSchema = z
  .object({
    host: remoteIdSchema,
    peer: remotePeerSchema,
    account: remoteAccountSchema,
    service: remoteOriginSchema,
    label: z.string(),
    privateKey: remoteIdentitySchema,
  })
  .strict();
