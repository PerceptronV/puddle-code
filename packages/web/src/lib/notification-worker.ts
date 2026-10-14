/** Mobile browsers require persistent notifications through a service worker. */
export async function notificationWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  const registration = await navigator.serviceWorker.register('/notification-worker.js');
  if (registration.active) return registration;
  const worker = registration.installing ?? registration.waiting;
  if (!worker) throw new Error('Notification support could not start. Reload and try again.');
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      worker.removeEventListener('statechange', changed);
      if (error) reject(error);
      else resolve();
    };
    const changed = () => {
      if (worker.state === 'activated') finish();
      else if (worker.state === 'redundant')
        finish(new Error('Notification support could not start.'));
    };
    const timer = setTimeout(() => finish(new Error('Notification support timed out.')), 10_000);
    worker.addEventListener('statechange', changed);
    changed();
  });
  return registration;
}

/** Serialise live and push delivery in the worker, so one event produces one alert. */
export async function showWorkerNotification(
  registration: ServiceWorkerRegistration,
  request: import('@puddle/shared').DesktopNotificationRequest,
): Promise<void> {
  if (!registration.active) throw new Error('Notification support is not active.');
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      channel.port1.close();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Notification delivery timed out.')), 10_000);
    channel.port1.onmessage = (event) =>
      finish(
        event.data?.ok
          ? undefined
          : new Error('The browser could not deliver the notification. Check system permissions.'),
      );
    registration.active!.postMessage({ t: 'show-notification', request }, [channel.port2]);
  });
}
