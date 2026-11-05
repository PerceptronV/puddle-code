import { createRoot } from 'react-dom/client';
import { installBrowserTransport, type CockpitSocket } from '../../lib/transport/browser-transport';
import { tokenStore } from '../../lib/transport/auth';
import { profileStore } from '../../features/profile/profile-store';
import { profile, project } from './data';
import { previewRequest } from './requests';

class PreviewSocket implements CockpitSocket {
  private events = new EventTarget();
  readyState: number = WebSocket.CONNECTING;
  constructor() {
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN;
      this.events.dispatchEvent(new Event('open'));
      this.events.dispatchEvent(
        new MessageEvent('message', { data: JSON.stringify({ t: 'authenticated' }) }),
      );
    });
  }
  addEventListener<K extends 'open' | 'message' | 'close'>(
    type: K,
    listener: (event: WebSocketEventMap[K]) => void,
  ) {
    this.events.addEventListener(type, listener as EventListener);
  }
  send() {
    /* No terminal processes in the preview. */
  }
  close() {
    this.readyState = WebSocket.CLOSED;
  }
}

export async function startPreview() {
  installBrowserTransport({
    scope: 'ui-preview',
    request: previewRequest,
    socket: () => new PreviewSocket(),
    input: async () => {
      throw new Error('Terminals need a daemon.');
    },
  });
  // Raw transfer/cockpit callers also terminate in fixtures. Vite's preview
  // mode has no gateway, so even an unhandled URL cannot reach the daemon.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin === location.origin && /^\/(api|cockpit|proxy)(\/|$)/.test(url.pathname)) {
      return previewRequest(
        init?.method ?? (input instanceof Request ? input.method : 'GET'),
        url.href,
      );
    }
    return nativeFetch(input, init);
  };
  tokenStore.set('sample-data-only');
  profileStore.set(profile.id);
  if (location.pathname === '/') history.replaceState(null, '', `/project/${project.id}`);
  const { App } = await import('../../App');
  createRoot(document.getElementById('root')!).render(<App />);
}
