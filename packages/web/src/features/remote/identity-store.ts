import { remoteBrowserHostSchema } from '@puddle/shared';

export type BrowserHost = ReturnType<typeof remoteBrowserHostSchema.parse>;
function key(service: string, account: string, host: string): string {
  return JSON.stringify([service, account, host]);
}
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('puddle-remote-identities', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('hosts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error('Private browser storage is unavailable; pairing cannot be saved'));
  });
}
async function access<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction('hosts', mode);
      const request = operation(transaction.objectStore('hosts'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(new Error('Could not save browser pairing'));
      transaction.onabort = () => reject(new Error('Could not save browser pairing'));
    });
  } finally {
    db.close();
  }
}
export async function loadBrowserHost(
  service: string,
  account: string,
  host: string,
): Promise<BrowserHost | null> {
  const value: unknown = await access('readonly', (store) =>
    store.get(key(service, account, host)),
  );
  if (value === undefined) return null;
  return remoteBrowserHostSchema.parse(value);
}
export async function saveBrowserHost(host: BrowserHost): Promise<void> {
  await access('readwrite', (store) =>
    store.put(remoteBrowserHostSchema.parse(host), key(host.service, host.account, host.host)),
  );
}
export async function forgetBrowserHost(host: BrowserHost): Promise<void> {
  await access('readwrite', (store) => store.delete(key(host.service, host.account, host.host)));
}
