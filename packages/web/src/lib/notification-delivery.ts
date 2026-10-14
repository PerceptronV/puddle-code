import { useSyncExternalStore } from 'react';
import {
  notificationDeliverySchema,
  type DesktopNotificationRequest,
  type NotificationDelivery,
} from '@puddle/shared';
import { notificationWorker, showWorkerNotification } from './notification-worker';
import { desktopBridge } from './desktop';

let outcome: NotificationDelivery = { state: 'unverified', message: null };
const listeners = new Set<() => void>();
const clicks = new Map<string, () => void>();
let subscribed = false;
let workerSubscribed = false;

function rememberClick(id: string, onClick: () => void): void {
  clicks.set(id, onClick);
  if (clicks.size > 64) clicks.delete(clicks.keys().next().value!);
}

function record(result: NotificationDelivery): NotificationDelivery {
  outcome = result;
  for (const listener of listeners) listener();
  return result;
}

export function useNotificationDelivery(): NotificationDelivery {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => outcome,
  );
}

export async function refreshNotificationDelivery(): Promise<void> {
  const bridge = desktopBridge();
  if (!bridge?.notificationStatus) return;
  try {
    record(notificationDeliverySchema.parse(await bridge.notificationStatus()));
  } catch {
    record({ state: 'failed', message: 'Could not read desktop notification delivery status.' });
  }
}

/** Keep failures visible in settings; event delivery must never reject unhandled. */
export async function deliverNotification(
  request: DesktopNotificationRequest,
  onClick: () => void,
): Promise<NotificationDelivery> {
  try {
    const bridge = desktopBridge();
    if (bridge?.showNotification) {
      if (!subscribed && bridge.onNotificationClick) {
        bridge.onNotificationClick((id) => {
          clicks.get(id)?.();
          clicks.delete(id);
        });
        subscribed = true;
      }
      rememberClick(request.id, onClick);
      return record(notificationDeliverySchema.parse(await bridge.showNotification(request)));
    }
    if (typeof Notification === 'undefined')
      return record({ state: 'unsupported', message: 'This browser cannot show notifications.' });
    if (Notification.permission !== 'granted')
      return record({
        state: 'failed',
        message: 'Allow notifications for Puddle in browser settings.',
      });
    const worker = await notificationWorker();
    if (worker) {
      if (!workerSubscribed) {
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data?.t !== 'notification-click' || typeof event.data.id !== 'string') return;
          clicks.get(event.data.id)?.();
          clicks.delete(event.data.id);
        });
        workerSubscribed = true;
      }
      rememberClick(request.id, onClick);
      await showWorkerNotification(worker, request);
      return record({ state: 'shown', message: null });
    }
    return await new Promise<NotificationDelivery>((resolve) => {
      const notification = new Notification(request.title, {
        body: request.body,
        tag: request.id,
        silent: true,
      });
      const timer = setTimeout(
        () =>
          resolve(
            record({
              state: 'unverified',
              message: 'Delivery has not been confirmed. Check system notification settings.',
            }),
          ),
        5000,
      );
      notification.onshow = () => {
        clearTimeout(timer);
        resolve(record({ state: 'shown', message: null }));
      };
      notification.onerror = () => {
        clearTimeout(timer);
        resolve(
          record({
            state: 'failed',
            message: 'The browser could not deliver the notification. Check system permissions.',
          }),
        );
      };
      notification.onclick = () => {
        window.focus();
        onClick();
        notification.close();
      };
    });
  } catch (error) {
    return record({
      state: 'failed',
      message: error instanceof Error ? error.message : 'Notification delivery failed.',
    });
  }
}
