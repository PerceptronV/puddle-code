import { z } from 'zod';

export const notificationPreferencesSchema = z.object({
  desktop: z.boolean().default(true),
  sound: z.boolean().default(false),
  when_focused: z.boolean().default(true),
  muted_projects: z.array(z.string()).default([]),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

/** Shell IPC only: no renderer-selected URLs or executable arguments. */
export const desktopNotificationRequestSchema = z
  .object({
    id: z.string().min(1).max(128),
    title: z.string().min(1).max(160),
    body: z.string().min(1).max(256),
  })
  .strict();
export type DesktopNotificationRequest = z.infer<typeof desktopNotificationRequestSchema>;

export const notificationDeliverySchema = z.object({
  state: z.enum(['unverified', 'shown', 'failed', 'unsupported']),
  message: z.string().max(512).nullable(),
});
export type NotificationDelivery = z.infer<typeof notificationDeliverySchema>;
