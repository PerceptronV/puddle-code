import { z } from 'zod';
import { remoteIdSchema, remoteSecretSchema } from './protocol.js';
import { notificationContentSchema } from '../notifications.js';

/** The key travels only inside the admitted browser's Noise connection. */
export const notificationPreviewKeySchema = z
  .object({ id: remoteIdSchema, secret: remoteSecretSchema })
  .strict();
export type NotificationPreviewKey = z.infer<typeof notificationPreviewKeySchema>;
export const encryptedNotificationSchema = z
  .object({
    key: remoteIdSchema,
    iv: z.string().regex(/^[a-f0-9]{24}$/),
    ciphertext: z
      .string()
      .min(32)
      .max(3072)
      .regex(/^(?:[a-f0-9]{2})+$/),
  })
  .strict();
export type EncryptedNotification = z.infer<typeof encryptedNotificationSchema>;

/** Vendor endpoints only: subscription URLs must never become an arbitrary HTTP proxy. */
export const pushEndpointSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    const host = url.hostname;
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      (host === 'fcm.googleapis.com' ||
        host === 'updates.push.services.mozilla.com' ||
        host === 'web.push.apple.com' ||
        host.endsWith('.notify.windows.com'))
    );
  }, 'Unsupported push service');
export const pushSubscriptionSchema = z
  .object({
    endpoint: pushEndpointSchema,
    expirationTime: z.number().positive().nullable().optional(),
    keys: z
      .object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}={0,1}$/),
        auth: z.string().regex(/^[A-Za-z0-9_-]{22}={0,2}$/),
      })
      .strict(),
  })
  .strict();
export type PushSubscriptionRecord = z.infer<typeof pushSubscriptionSchema>;

/** Connector-local operation, bound to the requesting Noise device by admission. */
export const pushPreferenceSchema = z
  .object({
    subscription: pushSubscriptionSchema.nullable(),
    preview_key: notificationPreviewKeySchema.optional(),
  })
  .strict();
export type PushPreference = z.infer<typeof pushPreferenceSchema>;
export const pushRegistrationSchema = pushPreferenceSchema
  .omit({ preview_key: true })
  .extend({ credential: remoteSecretSchema, device: remoteIdSchema })
  .strict();
export const pushDispatchSchema = z
  .object({
    credential: remoteSecretSchema,
    devices: z.array(remoteIdSchema).min(1).max(64),
    id: remoteIdSchema,
    preview: encryptedNotificationSchema.optional(),
  })
  .strict();
export const pushPayloadSchema = z
  .object({
    id: remoteIdSchema,
    host: remoteIdSchema,
    preview: encryptedNotificationSchema.optional(),
  })
  .strict();
/** Same-user private IPC only. The connector encrypts content separately for each device. */
export const connectorNotificationSchema = z
  .object({
    t: z.literal('notify'),
    id: remoteIdSchema,
    content: notificationContentSchema.optional(),
  })
  .strict();

export const pushDispatchResultSchema = z
  .object({ accepted: z.number().int().nonnegative(), failed: z.number().int().nonnegative() })
  .strict();

export const pushPreferenceResultSchema = z.object({ enabled: z.boolean() }).strict();
