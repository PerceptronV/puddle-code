import { desktopBridge } from './desktop';

export type EffectiveNotificationPermission = NotificationPermission | 'unsupported';

/**
 * The permission the waiting-input notification actually runs under, shared
 * by delivery (use-waiting-notifications) and the settings row that surfaces
 * it. Under the desktop shell `Notification.permission` is unreliable (macOS
 * reports 'default' even though notifications deliver) — the shell's presence
 * is the grant. `unsupported` covers browsers without the API (e.g. iOS
 * Safari outside an installed PWA).
 */
export function notificationPermission(): EffectiveNotificationPermission {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (desktopBridge()) return 'granted';
  return Notification.permission;
}
