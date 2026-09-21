import { z } from 'zod';
import { wsClientMessageSchema, wsServerMessageSchema } from '../ws/messages.js';

/** Independent transport contract; host authority uses the daemon's protocol-18 leases. */
export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_POLICY = {
  chunkBytes: 32 * 1024,
  frameBytes: 48 * 1024,
  requestBytes: 256 * 1024,
  responseBytes: 16 * 1024 * 1024,
  queueBytes: 1024 * 1024,
  relayQueueBytes: 64 * 1024 * 1024,
  requests: 8,
  connectionsPerHost: 8,
  connectionsPerAccount: 16,
  connections: 128,
  handshakeMs: 10_000,
  invitationMs: 300_000,
  idleMs: 30 * 24 * 60 * 60 * 1000,
  absoluteMs: 90 * 24 * 60 * 60 * 1000,
} as const;

export const remoteIdSchema = z.string().uuid();
export const remoteSecretSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const remotePeerSchema = z.string().min(20).max(128);
export const remoteAccountSchema = z.string().min(1).max(128);
export const remoteLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  // eslint-disable-next-line no-control-regex -- Reject control characters at the trust boundary.
  .regex(/^[^\u0000-\u001f\u007f]+$/);
export const remoteOriginSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'An exact HTTPS origin is required');

export const remoteInvitationSchema = z
  .object({
    version: z.literal(REMOTE_PROTOCOL_VERSION),
    service: remoteOriginSchema,
    host: remoteIdSchema,
    peer: remotePeerSchema,
    invitation: remoteSecretSchema,
    expires: z.number().int().positive(),
  })
  .strict();
export type RemoteInvitation = z.infer<typeof remoteInvitationSchema>;

export const remoteConnectSchema = z
  .object({ t: z.literal('connect'), host: remoteIdSchema })
  .strict();
export const relayMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('registered'), host: remoteIdSchema }).strict(),
  z
    .object({ t: z.literal('open'), connection: remoteIdSchema, account: remoteAccountSchema })
    .strict(),
  z
    .object({ t: z.literal('ready'), connection: remoteIdSchema, account: remoteAccountSchema })
    .strict(),
]);
export type RelayMessage = z.infer<typeof relayMessageSchema>;

export const remoteDeviceSchema = z.object({
  id: remoteIdSchema,
  peer: remotePeerSchema,
  account: remoteAccountSchema,
  label: remoteLabelSchema,
  created: z.number(),
  lastUsed: z.number(),
  expires: z.number(),
  status: z.enum(['pending', 'approved', 'revoked']),
});
export type RemoteDevice = z.infer<typeof remoteDeviceSchema>;
export const remoteAdminRequestSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('status') }).strict(),
  z.object({ t: z.literal('pair') }).strict(),
  z.object({ t: z.literal('devices') }).strict(),
  z.object({ t: z.literal('approve'), id: remoteIdSchema }).strict(),
  z.object({ t: z.literal('revoke'), id: remoteIdSchema }).strict(),
  z.object({ t: z.literal('disable') }).strict(),
]);
export type RemoteAdminRequest = z.infer<typeof remoteAdminRequestSchema>;
export const remoteAdminResponseSchema = z
  .object({
    enabled: z.boolean().optional(),
    connected: z.boolean().optional(),
    host: remoteIdSchema.optional(),
    peer: remotePeerSchema.optional(),
    invitation: remoteInvitationSchema.optional(),
    url: z.string().url().optional(),
    devices: z.array(remoteDeviceSchema).optional(),
    error: z.string().max(256).optional(),
  })
  .strict();
export type RemoteAdminResponse = z.infer<typeof remoteAdminResponseSchema>;

/** Application framing is inside Noise. It never implements encryption or accepts credentials. */
export const remoteMessageSchema = z.discriminatedUnion('t', [
  z
    .object({
      t: z.literal('hello'),
      account: remoteAccountSchema,
      label: remoteLabelSchema,
      invitation: remoteSecretSchema.optional(),
    })
    .strict(),
  z.object({ t: z.literal('pending'), device: remoteDeviceSchema }).strict(),
  z
    .object({ t: z.literal('admitted'), generation: remoteIdSchema, device: remoteIdSchema })
    .strict(),
  z
    .object({ t: z.literal('challenge'), nonce: remoteSecretSchema, generation: remoteIdSchema })
    .strict(),
  z
    .object({
      t: z.literal('participate'),
      nonce: remoteSecretSchema,
      generation: remoteIdSchema,
      resources: z.array(remoteIdSchema).max(REMOTE_POLICY.requests + 1),
    })
    .strict(),
  z
    .object({
      t: z.literal('request'),
      id: remoteIdSchema,
      method: z.enum(['GET', 'POST', 'PATCH']),
      path: z.string().max(8192),
      body: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      t: z.literal('response'),
      id: remoteIdSchema,
      status: z.number().int().min(100).max(599),
      body: z.unknown(),
    })
    .strict(),
  z.object({ t: z.literal('cancel'), id: remoteIdSchema }).strict(),
  z.object({ t: z.literal('stream'), id: remoteIdSchema }).strict(),
  z
    .object({ t: z.literal('terminal'), id: remoteIdSchema, message: wsClientMessageSchema })
    .strict(),
  z.object({ t: z.literal('event'), message: wsServerMessageSchema }).strict(),
  z.object({ t: z.literal('sent'), id: remoteIdSchema }).strict(),
  z
    .object({ t: z.literal('admin'), id: remoteIdSchema, request: remoteAdminRequestSchema })
    .strict(),
  z
    .object({ t: z.literal('admin-result'), id: remoteIdSchema, result: remoteAdminResponseSchema })
    .strict(),
  z
    .object({
      t: z.literal('error'),
      code: z.enum(['rejected', 'expired', 'unavailable', 'protocol_mismatch']),
      message: z.string().max(256),
    })
    .strict(),
]);
export type RemoteMessage = z.infer<typeof remoteMessageSchema>;

export const remoteChunkSchema = z
  .object({
    id: remoteIdSchema,
    index: z.number().int().min(0).max(8192),
    end: z.boolean(),
    data: z.string().max(REMOTE_POLICY.chunkBytes),
  })
  .strict();
