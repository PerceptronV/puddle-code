import { DaemonClient, readDaemonPort } from './daemon-client.js';
import { ensureDaemon, makeUpgrader, type RunningCockpit } from './cockpit.js';
import { runHandshake } from './handshake.js';
import { waitForHttp } from './net.js';
import { startUiServer } from './serve/ui-server.js';
import { openTunnel } from './tunnel.js';
import { LocalTransport } from './transport/local.js';
import { SshTransport } from './transport/ssh.js';
import type { CliEvent, Logger } from './types.js';
import { silentLogger } from './types.js';

export interface ConnectOptions {
  host: string;
  /** UI port; auto-picks the next free one when omitted (7433 default). */
  port?: number;
  /** Preferred (non-strict) UI port — where the probe starts. `refresh` passes
   *  the old cockpit's port so an open browser tab keeps its origin. */
  preferPort?: number;
  /** Daemon port on the host, when its config.json cannot be trusted. */
  remotePort?: number;
  /** Dev override: install the daemon from this local tarball. */
  tarball?: string;
  assetsDir: string;
  noUpgrade?: boolean;
  logger?: Logger;
  /** POST /cockpit/refresh (the UI's refresh button) invokes this — the CLI
   *  layer supplies the process-spawning behaviour; lib stays process-free. */
  onRefreshRequest?: () => void;
  /** Test seams. */
  sshBinary?: string;
  scpBinary?: string;
  platform?: NodeJS.Platform;
}

/**
 * SSH mode (SPEC §10): master connection → bootstrap/upgrade the daemon →
 * tunnel → handshake → serve the UI locally with /api + /ws proxied through
 * the tunnel. Ctrl-C (the caller's stop()) closes the tunnel and UI server
 * only — the daemon and its agents keep running.
 */
export async function connectRemote(opts: ConnectOptions): Promise<RunningCockpit> {
  const logger = opts.logger ?? silentLogger;
  const platform = opts.platform ?? process.platform;
  const ssh = new SshTransport(opts.host, {
    sshBinary: opts.sshBinary,
    scpBinary: opts.scpBinary,
    platform,
  });
  if (platform === 'win32') {
    logger.warn(
      'Windows OpenSSH cannot share a connection; you may be asked to authenticate more than once. ' +
        'An SSH key (ssh-copy-id) avoids the prompts.',
    );
  }
  await ssh.open();

  const bootstrap = { tarball: opts.tarball, logger };
  const endpoint = await ensureDaemon(ssh, bootstrap);
  const remotePort = opts.remotePort ?? endpoint.port;

  // Readiness is the daemon answering /api/version through the forward — any
  // HTTP status proves the byte path (the authenticated handshake follows).
  const tunnel = await openTunnel(ssh, remotePort, {
    sshBinary: opts.sshBinary,
    logger,
    ready: (localPort) => waitForHttp(`http://127.0.0.1:${localPort}/api/version`, 8000),
  });
  const client = new DaemonClient(tunnel.localPort, endpoint.token);
  tunnel.onPortChange((port) => client.setPort(port));

  const daemon = await runHandshake({
    client,
    noUpgrade: opts.noUpgrade,
    upgradeDaemon: makeUpgrader(ssh, client, bootstrap),
    logger,
  });

  // Never squat the port a local `puddle start` will probe for its own daemon,
  // or that probe would find this cockpit's proxy answering for a different
  // (remote) daemon and abort with a port conflict. That target is the LOCAL
  // daemon's configured port — read from this machine's config.json the same
  // way `start` does — not `endpoint.port`, which is the remote daemon's and
  // only coincides when the remote uses the default 7434.
  const avoidPort = await readDaemonPort(new LocalTransport());

  const ui = await startUiServer({
    assetsDir: opts.assetsDir,
    port: opts.port ?? opts.preferPort,
    strictPort: opts.port !== undefined, // a preferred port stays non-strict
    avoidPort,
    target: { host: '127.0.0.1', port: tunnel.localPort },
    ...(opts.onRefreshRequest !== undefined
      ? { control: { token: endpoint.token, onRefresh: opts.onRefreshRequest } }
      : {}),
  });
  tunnel.onPortChange((port) => ui.setTarget({ host: '127.0.0.1', port }));

  const eventCbs = new Set<(e: CliEvent) => void>();
  tunnel.onEvent((e) => {
    if (e.t === 'tunnel-down') logger.warn(`tunnel to ${opts.host} lost — reconnecting…`);
    if (e.t === 'tunnel-up') logger.info('tunnel restored');
    eventCbs.forEach((cb) => cb(e));
  });

  return {
    origin: ui.origin,
    browserUrl: `${ui.origin}/?host=${encodeURIComponent(opts.host)}#token=${endpoint.token}`,
    nonce: ui.nonce,
    daemon,
    onEvent(cb) {
      eventCbs.add(cb);
      return () => eventCbs.delete(cb);
    },
    async stop() {
      await ui.close();
      await tunnel.close();
      ssh.dispose();
    },
  };
}
