/* global self, indexedDB, crypto, TextEncoder, TextDecoder */
/* Notifications only: no fetch interception or caching of host content. */
let queue = Promise.resolve();
let database;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function targetOf(value) {
  if (
    !value ||
    !/^[0-9a-f]{10}$/.test(value.project) ||
    !uuid.test(value.session) ||
    (value.host !== undefined && !uuid.test(value.host))
  )
    return undefined;
  return {
    project: value.project,
    session: value.session,
    ...(value.host ? { host: value.host } : {}),
  };
}
function validContent(value) {
  return (
    value &&
    typeof value.title === 'string' &&
    value.title.length > 0 &&
    value.title.length <= 160 &&
    typeof value.body === 'string' &&
    value.body.length > 0 &&
    value.body.length <= 256 &&
    targetOf(value)
  );
}
function bytes(hex) {
  return Uint8Array.from(hex.match(/../g), (byte) => parseInt(byte, 16));
}
async function decryptPreview(payload) {
  const preview = payload.preview;
  if (
    !preview ||
    !uuid.test(preview.key) ||
    !/^[a-f0-9]{24}$/.test(preview.iv) ||
    typeof preview.ciphertext !== 'string' ||
    preview.ciphertext.length > 3072 ||
    !/^(?:[a-f0-9]{2}){16,}$/.test(preview.ciphertext)
  )
    return null;
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('puddle-notification-keys', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys', { keyPath: 'host' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const saved = await new Promise((resolve, reject) => {
      const request = db.transaction('keys').objectStore('keys').get(payload.host);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!saved || saved.id !== preview.key || !/^[a-f0-9]{64}$/.test(saved.secret)) return null;
    const key = await crypto.subtle.importKey('raw', bytes(saved.secret), 'AES-GCM', false, [
      'decrypt',
    ]);
    const clear = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes(preview.iv),
        additionalData: new TextEncoder().encode(
          JSON.stringify(['puddle-notification-v1', payload.host, payload.id, preview.key]),
        ),
      },
      key,
      bytes(preview.ciphertext),
    );
    const content = JSON.parse(new TextDecoder().decode(clear));
    return validContent(content) ? content : null;
  } finally {
    db.close();
  }
}
function receipts() {
  if (!database)
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open('puddle-notification-receipts', 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('seen', { keyPath: 'id' }).createIndex('at', 'at');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  return database;
}
async function seen(id, save = false) {
  const db = await receipts();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('seen', save ? 'readwrite' : 'readonly');
    const store = tx.objectStore('seen');
    let found = false;
    const read = store.get(id);
    read.onsuccess = () => {
      found = !!read.result && read.result.at > Date.now() - 86400000;
    };
    if (save) {
      store.put({ id, at: Date.now() });
      const count = store.count();
      count.onsuccess = () => {
        let remove = Math.max(0, count.result - 512);
        const cursor = store.index('at').openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row || (remove <= 0 && row.value.at > Date.now() - 86400000)) return;
          row.delete();
          remove--;
          row.continue();
        };
      };
    }
    tx.oncomplete = () => resolve(found);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
function show(request, host, fromPush = false, client) {
  const task = queue.then(async () => {
    if (typeof request === 'function') request = await request();
    const deduplicate = request.id.startsWith('puddle-event-');
    // Every push must call showNotification: Safari revokes permission for
    // silent pushes. Matching tags replace a racing live alert without renotify.
    if (deduplicate && !fromPush && (await seen(request.id).catch(() => false))) return;
    await self.registration.showNotification(request.title, {
      body: request.body,
      tag: request.id,
      silent: true,
      renotify: false,
      data: {
        ...(host ? { host } : { client }),
        ...(targetOf(request.target) ? { target: targetOf(request.target) } : {}),
      },
      icon: '/puddle-app.png',
    });
    if (deduplicate) await seen(request.id, true).catch(() => {});
  });
  queue = task.catch(() => {});
  return task;
}
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  const request = event.data?.request;
  if (
    event.data?.t !== 'show-notification' ||
    !event.source?.url ||
    new URL(event.source.url).origin !== self.location.origin ||
    typeof request?.id !== 'string' ||
    request.id.length > 128 ||
    typeof request.title !== 'string' ||
    request.title.length > 160 ||
    typeof request.body !== 'string' ||
    request.body.length > 256
  )
    return;
  event.waitUntil(
    show(request, undefined, false, event.source.id).then(
      () => event.ports[0]?.postMessage({ ok: true }),
      () => event.ports[0]?.postMessage({ ok: false }),
    ),
  );
});
self.addEventListener('push', (event) => {
  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  if (!uuid.test(payload?.id) || !uuid.test(payload?.host)) return;
  event.waitUntil(
    show(
      async () => {
        // A missing/rotated key or damaged ciphertext must still produce a visible push.
        const content = await decryptPreview(payload).catch(() => null);
        return {
          id: `puddle-event-${payload.id}`,
          title: content?.title ?? 'Puddle',
          body: content?.body ?? 'An agent needs your attention.',
          ...(content
            ? { target: { project: content.project, session: content.session, host: payload.host } }
            : {}),
        };
      },
      payload.host,
      true,
    ),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destination = targetOf(event.notification.data?.target);
  const host = destination?.host ?? event.notification.data?.host;
  const target = uuid.test(host)
    ? `/?notificationHost=${host}${destination ? `&notificationProject=${destination.project}&notificationSession=${destination.session}` : ''}`
    : destination
      ? `/project/${destination.project}/session/${destination.session}`
      : '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      windows.sort(
        (a, b) =>
          Number(b.id === event.notification.data?.client) -
          Number(a.id === event.notification.data?.client),
      );
      for (const client of windows) {
        if (
          client.frameType !== 'top-level' ||
          new URL(client.url).origin !== self.location.origin ||
          new URL(client.url).pathname === '/preview.html'
        )
          continue;
        try {
          await client.focus();
        } catch {
          continue;
        }
        client.postMessage({
          t: 'notification-click',
          id: event.notification.tag,
          ...(uuid.test(host) ? { host } : {}),
          ...(destination ? { target: destination } : {}),
        });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
