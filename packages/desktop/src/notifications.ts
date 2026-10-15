import { Notification, type BrowserWindow } from 'electron';
import { desktopNotificationRequestSchema, type NotificationDelivery } from '@puddle/shared';
import { notificationOptions } from './notification-options.js';

function failureMessage(error: unknown): string {
  const detail = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  // Electron 43.2.0 forwards NSError.localizedDescription, not the structured
  // UNError code. Only recognise the explicit notifications-not-allowed code;
  // keep other errors (including unrecognised translations) intact.
  if (/\bUNErrorDomain\s+(?:error\s+|Code=)1\b/.test(detail)) {
    return (
      'macOS has not authorised notifications for Puddle. Enable Allow notifications in ' +
      'System Settings → Notifications → Puddle, then send another test. ' +
      'If Puddle is missing, install a build with a valid app signature. ' +
      detail
    ).slice(0, 512);
  }
  return detail.slice(0, 512) || 'The system rejected the notification.';
}

/** Native delivery reports failures that Chromium's permission flag cannot describe. */
export class DesktopNotifications {
  private readonly active = new Map<string, Notification>();
  private readonly pending = new Set<() => void>();
  private result: NotificationDelivery = { state: 'unverified', message: null };
  private closed = false;

  constructor(
    private readonly win: BrowserWindow,
    private readonly raise: () => void,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  status(): NotificationDelivery {
    return Notification.isSupported()
      ? this.result
      : { state: 'unsupported', message: 'System notifications are unavailable on this desktop.' };
  }

  async show(value: unknown): Promise<NotificationDelivery> {
    const request = desktopNotificationRequestSchema.parse(value);
    if (this.closed || this.win.isDestroyed())
      return { state: 'failed', message: 'The notification window has closed.' };
    if (!Notification.isSupported()) return this.status();
    this.active.get(request.id)?.close();
    if (this.active.size >= 64) {
      const first = this.active.keys().next().value;
      if (first !== undefined) {
        this.active.get(first)?.close();
        this.active.delete(first);
      }
    }
    return new Promise((resolve) => {
      let notification: Notification | undefined;
      let settled = false;
      const finish = (result: NotificationDelivery) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(cancel);
        this.result = result;
        resolve(result);
      };
      const cancel = () =>
        finish({ state: 'failed', message: 'The notification window has closed.' });
      const timer = setTimeout(
        () =>
          finish({
            state: 'unverified',
            message:
              'The system has not confirmed delivery. Check notification permissions and Focus / Do Not Disturb settings.',
          }),
        5000,
      );
      this.pending.add(cancel);
      try {
        notification = new Notification(notificationOptions(request, this.platform));
        const current = notification;
        this.active.set(request.id, current);
        current.on('show', () => finish({ state: 'shown', message: null }));
        current.on('failed', (_event, error) => {
          finish({
            state: 'failed',
            message: failureMessage(error),
          });
          if (this.active.get(request.id) === current) this.active.delete(request.id);
        });
        current.on('close', () => {
          if (this.active.get(request.id) === current) this.active.delete(request.id);
        });
        current.on('click', () => {
          if (this.closed || this.win.isDestroyed()) return;
          this.raise();
          if (request.target)
            this.win.webContents.send('puddle:notification-click', request.id, request.target);
          else this.win.webContents.send('puddle:notification-click', request.id);
          current.close();
        });
        current.show();
      } catch (error) {
        finish({
          state: 'failed',
          message: failureMessage(error),
        });
        notification?.close();
        this.active.delete(request.id);
      }
    });
  }

  close(): void {
    this.closed = true;
    for (const cancel of this.pending) cancel();
    for (const notification of this.active.values()) notification.close();
    this.active.clear();
  }
}
