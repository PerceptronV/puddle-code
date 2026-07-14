import type { Duplex } from 'node:stream';

/**
 * Tracks the live client↔upstream socket pairs a proxied WebSocket owns. These
 * outbound upstream sockets are opened by the daemon (via `http.request`) and
 * are NOT covered by `server.closeAllConnections()`, so without this they would
 * keep the event loop — and `stop()` — alive after the HTTP server has closed.
 * A pair auto-removes when either socket closes; `destroyAll()` tears down the
 * rest at shutdown.
 */
export class ProxySocketTracker {
  private readonly pairs = new Set<{ client: Duplex; upstream: Duplex }>();

  add(client: Duplex, upstream: Duplex): void {
    const pair = { client, upstream };
    this.pairs.add(pair);
    const drop = () => this.pairs.delete(pair);
    client.once('close', drop);
    upstream.once('close', drop);
  }

  destroyAll(): void {
    for (const { client, upstream } of this.pairs) {
      client.destroy();
      upstream.destroy();
    }
    this.pairs.clear();
  }

  get size(): number {
    return this.pairs.size;
  }
}
