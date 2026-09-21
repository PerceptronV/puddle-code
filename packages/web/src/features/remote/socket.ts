import type { WsClientMessage } from '@puddle/shared';
import type { RemoteClient } from './client';

/** Existing terminal registration/snapshot logic consumes this socket-shaped view. */
export class RemoteSocket {
  private readonly events = new EventTarget();
  addEventListener<K extends 'open' | 'message' | 'close'>(
    type: K,
    listener: (event: WebSocketEventMap[K]) => void,
  ): void {
    this.events.addEventListener(type, listener as EventListener);
  }
  readyState: number = WebSocket.CONNECTING;
  private readonly offState: () => void;
  private readonly offTerminal: () => void;
  constructor(private readonly client: RemoteClient) {
    this.offTerminal = client.onTerminal((message) => {
      if (this.readyState === WebSocket.OPEN)
        this.events.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
    });
    this.offState = client.onState(() => {
      if (client.state === 'ready') void this.open();
      else if (client.state === 'disconnected' || client.state === 'rejected') this.close();
    });
    queueMicrotask(() => {
      if (client.state === 'ready') void this.open();
      else client.start();
    });
  }
  private async open(): Promise<void> {
    if (this.readyState !== WebSocket.CONNECTING) return;
    this.readyState = WebSocket.OPEN;
    this.events.dispatchEvent(new Event('open'));
    try {
      await this.client.openStream();
    } catch {
      this.close();
    }
  }
  send(data: string): void {
    if (this.readyState !== WebSocket.OPEN) throw new Error('Terminal is disconnected');
    void this.client.terminal(JSON.parse(data) as WsClientMessage).catch(() => this.close());
  }
  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.offState();
    this.offTerminal();
    if (this.client.state === 'ready') this.client.restartConnection();
    this.events.dispatchEvent(
      new CloseEvent('close', { code: 4410, reason: 'upstream_unavailable' }),
    );
  }
}
