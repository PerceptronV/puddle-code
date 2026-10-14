import { createCipheriv, randomBytes } from 'node:crypto';
import {
  notificationContentSchema,
  type EncryptedNotification,
  type NotificationContent,
  type NotificationPreviewKey,
} from '@puddle/shared';

/** Standard AES-256-GCM; the relay receives neither the key nor the plaintext. */
export function encryptNotification(
  content: NotificationContent,
  key: NotificationPreviewKey,
  host: string,
  id: string,
): EncryptedNotification {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key.secret, 'hex'), iv);
  cipher.setAAD(Buffer.from(JSON.stringify(['puddle-notification-v1', host, id, key.id])));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(notificationContentSchema.parse(content)), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { key: key.id, iv: iv.toString('hex'), ciphertext: encrypted.toString('hex') };
}
