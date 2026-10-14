import { notificationPreviewKeySchema, type NotificationPreviewKey } from '@puddle/shared';

interface SavedKey extends NotificationPreviewKey {
  host: string;
  account: string;
  service: string;
}

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('puddle-notification-keys', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys', { keyPath: 'host' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Could not save the notification preview key.'));
  });
}

/** One host/account-bound key, exchanged only through the approved Noise connection. */
export async function notificationKey(
  service: string,
  account: string,
  host: string,
): Promise<NotificationPreviewKey> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite');
      const store = tx.objectStore('keys');
      const read = store.get(host);
      let value: SavedKey;
      read.onsuccess = () => {
        const previous = read.result as SavedKey | undefined;
        if (
          previous?.account === account &&
          previous.service === service &&
          notificationPreviewKeySchema.safeParse({ id: previous.id, secret: previous.secret })
            .success
        )
          value = previous;
        else {
          value = {
            id: crypto.randomUUID(),
            secret: [...crypto.getRandomValues(new Uint8Array(32))]
              .map((byte) => byte.toString(16).padStart(2, '0'))
              .join(''),
            host,
            account,
            service,
          };
          store.put(value);
        }
      };
      tx.oncomplete = () => resolve({ id: value.id, secret: value.secret });
      tx.onerror = tx.onabort = () =>
        reject(new Error('Could not save the notification preview key.'));
    });
  } finally {
    db.close();
  }
}

export async function forgetNotificationKeys(
  service: string,
  account: string,
  host?: string,
): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite');
      const cursor = tx.objectStore('keys').openCursor();
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        const value = row.value as SavedKey;
        if (
          value.service === service &&
          value.account === account &&
          (!host || value.host === host)
        )
          row.delete();
        row.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(new Error('Could not remove notification preview keys.'));
    });
  } finally {
    db.close();
  }
}
