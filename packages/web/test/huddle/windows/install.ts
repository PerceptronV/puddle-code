import { profileStore } from '../../../src/features/profile/profile-store';
import { tokenStore } from '../../../src/lib/transport/auth';
import {
  browserTransport,
  installBrowserTransport,
} from '../../../src/lib/transport/browser-transport';

declare global {
  interface Window {
    huddleWindowRequest(
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; body: unknown } | null>;
  }
}
let installed = false;
/** Upgrade only this isolated preview page to the local transport shape huddles use. */
export function installHuddleWindows() {
  if (installed) return;
  const transport = browserTransport();
  if (import.meta.env.MODE !== 'ui-preview' || transport?.scope !== 'ui-preview')
    throw new Error('Requires UI-only preview');
  installed = true;
  const native = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (!/^\/(api|frontend|proxy)(\/|$)/.test(url.pathname)) return native(input, init);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const result = await window.huddleWindowRequest(method, url.pathname + url.search, body);
    return result
      ? Response.json(result.body, { status: result.status })
      : transport.request(method, url.pathname + url.search, body);
  };
  window.WebSocket = class extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      super();
      queueMicrotask(() => {
        this.dispatchEvent(new Event('open'));
        this.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify({ t: 'authenticated' }) }),
        );
      });
    }
    send() {}
    close() {}
  } as unknown as typeof WebSocket;
  const profile = profileStore.get();
  const token = tokenStore.get();
  installBrowserTransport(null);
  profileStore.set(profile);
  tokenStore.set(token);
}
