import { DaemonClient } from './daemon-client.js';
import { ensureDaemon, makeUpgrader, type RunningCockpit } from './cockpit.js';
import { runHandshake } from './handshake.js';
import { startUiServer } from './serve/ui-server.js';
import { LocalTransport } from './transport/local.js';
import type { CliEvent, Logger } from './types.js';
import { silentLogger } from './types.js';

export interface StartOptions {
  /** UI port; auto-picks the next free one when omitted (7433 default). */
  port?: number;
  /** Dev override: install the daemon from this local tarball. */
  tarball?: string;
  /** Directory holding the built web UI. */
  assetsDir: string;
  noUpgrade?: boolean;
  logger?: Logger;
}

/**
 * Local mode (SPEC §10): ensure puddled runs on THIS machine, then serve the
 * UI with /api + /ws proxied to it — the same serve path as remote mode, no
 * SSH and no tunnel.
 */
export async function startLocal(opts: StartOptions): Promise<RunningCockpit> {
  const logger = opts.logger ?? silentLogger;
  const transport = new LocalTransport();
  const bootstrap = { tarball: opts.tarball, logger };

  const endpoint = await ensureDaemon(transport, bootstrap);
  const client = new DaemonClient(endpoint.port, endpoint.token);
  const daemon = await runHandshake({
    client,
    noUpgrade: opts.noUpgrade,
    upgradeDaemon: makeUpgrader(transport, client, bootstrap),
    logger,
  });

  const ui = await startUiServer({
    assetsDir: opts.assetsDir,
    port: opts.port,
    strictPort: opts.port !== undefined,
    target: { host: '127.0.0.1', port: endpoint.port },
  });

  const eventCbs = new Set<(e: CliEvent) => void>();
  return {
    origin: ui.origin,
    browserUrl: `${ui.origin}/#token=${endpoint.token}`,
    daemon,
    onEvent(cb) {
      eventCbs.add(cb);
      return () => eventCbs.delete(cb);
    },
    async stop() {
      await ui.close();
      transport.dispose();
    },
  };
}
