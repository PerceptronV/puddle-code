import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Terminal as XTerm } from '@xterm/xterm';
import type { WsClientMessage, WsServerMessage } from '@puddle/shared';
import {
  installBrowserTransport,
  type FrontendSocket,
} from '../../src/lib/transport/browser-transport';
import { wsManager } from '../../src/lib/transport/ws';
import { KeepAliveHost, useKeepAliveSlot } from '../../src/features/workspace/keep-alive';
import { makeLeaf } from '../../src/features/workspace/layout/layout-tree';
import { warmTerminalChunk } from '../../src/features/terminal/LazyTerminal';
import { MobileTerminal } from '../../src/features/mobile/MobileTerminal';

// Instrument actual xterm lifetimes; transport data is entirely synthetic.
const terminals = new Map<string, XTerm>();
const mounts = new Map<string, number>();
const containers = new Map<string, HTMLElement>();
const originalOpen = XTerm.prototype.open;
XTerm.prototype.open = function (element) {
  const id = element.parentElement!.dataset.notificationSession!;
  terminals.set(id, this);
  mounts.set(id, (mounts.get(id) ?? 0) + 1);
  containers.set(id, element.parentElement!.parentElement!);
  const dispose = this.dispose.bind(this);
  this.dispose = () => {
    if (terminals.get(id) === this) terminals.delete(id);
    dispose();
  };
  return originalOpen.call(this, element);
};
let automaticReplay = true;
let online = true;
const sent: WsClientMessage[] = [];
class Socket extends EventTarget implements FrontendSocket {
  readyState: number = WebSocket.OPEN;
  constructor() {
    super();
    setTimeout(() => {
      if (online) {
        this.dispatchEvent(new Event('open'));
        this.emit({ t: 'authenticated' });
      }
    }, 0);
  }
  emit(message: WsServerMessage) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
  send(data: string) {
    const message = JSON.parse(data) as WsClientMessage;
    sent.push(message);
    if (automaticReplay && message.t === 'attach') {
      queueMicrotask(() =>
        this.emit({
          t: 'replay',
          session: message.session,
          term: message.term,
          data: Array.from({ length: 100 }, (_, i) => `synthetic ${message.session} row ${i}`).join(
            '\r\n',
          ),
        }),
      );
    }
  }
  close() {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close', { code: 1000 }));
  }
}
let socket: Socket;
installBrowserTransport({
  scope: 'synthetic-host',
  async request(_method, path) {
    return Response.json(path.endsWith('/version') ? { protocol: { major: 26, minor: 0 } } : {});
  },
  socket() {
    return (socket = new Socket());
  },
  async input() {},
});
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
queries.setQueryData(['version'], { protocol: { major: 26, minor: 0 } });
const root = createRoot(document.getElementById('root')!);
function Slot({ session, side }: { session: string | null; side: string }) {
  const ref = useKeepAliveSlot(session ? `term:${session}` : null);
  return <div ref={ref} data-side={side} style={{ width: 720, height: 400 }} />;
}
function show(active: string | null, open: string[], side = 'left') {
  root.render(
    <QueryClientProvider client={queries}>
      <KeepAliveHost
        tree={makeLeaf(active ? [{ type: 'terminal', session: active }] : [])}
        parked={open}
        onOpenFile={() => {}}
      >
        <Slot side="left" session={side === 'left' ? active : null} />
        <Slot side="right" session={side === 'right' ? active : null} />
      </KeepAliveHost>
    </QueryClientProvider>,
  );
}
function state(id: string) {
  const terminal = terminals.get(id);
  const buffer = terminal?.buffer.active;
  return {
    mounts: mounts.get(id) ?? 0,
    live: !!terminal,
    parent: containers.get(id)?.closest<HTMLElement>('[data-side]')?.dataset.side ?? null,
    viewport: buffer?.viewportY,
    lines: buffer
      ? Array.from({ length: buffer.length }, (_, row) =>
          buffer.getLine(row)!.translateToString(true),
        )
      : [],
  };
}
Object.assign(window, {
  async ready() {
    await warmTerminalChunk();
  },
  show,
  mobile(connected: boolean) {
    root.render(
      <QueryClientProvider client={queries}>
        <div style={{ width: 720, height: 400 }}>
          <MobileTerminal
            session="mobile"
            term="agent"
            active
            connected={connected}
            attached={connected}
          />
        </div>
      </QueryClientProvider>,
    );
  },
  state,
  stats() {
    return { live: [...terminals.keys()], sent };
  },
  scroll(id: string, line: number) {
    terminals.get(id)!.scrollToLine(line);
  },
  select(id: string) {
    terminals.get(id)!.select(0, terminals.get(id)!.buffer.active.viewportY, 9);
  },
  async drain(id: string) {
    await new Promise<void>((resolve) => terminals.get(id)!.write('', resolve));
  },
  copy(id: string) {
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData });
    terminals.get(id)!.element!.dispatchEvent(event);
    return clipboardData.getData('text/plain');
  },
  input(id: string, data: string) {
    terminals.get(id)!.input(data, true);
  },
  emit(message: WsServerMessage) {
    socket.emit(message);
  },
  holdReplay() {
    automaticReplay = false;
  },
  disconnect() {
    automaticReplay = false;
    online = false;
    wsManager.reset();
  },
  reconnect() {
    online = true;
    socket.emit({ t: 'authenticated' });
  },
  shutdown() {
    root.unmount();
    wsManager.switchHost();
    containers.clear();
  },
});
