import { DaemonClient } from './daemon-client.js';
import { ensureDaemon, makeUpgrader, type RunningCockpit } from './cockpit.js';
import { runHandshake } from './handshake.js';
import { startUiServer } from './serve/ui-server.js';
import { openTunnel } from './tunnel.js';
import { SshTransport } from './transport/ssh.js';
import type { CliEvent, Logger } from './types.js';
import { silentLogger } from './types.js';

export interface ConnectOptions {
  host: string;
  /** UI port; auto-picks the next free one when omitted (7433 default). */
  port?: number;
  /** Daemon port on the host, when its config.json cannot be trusted. */
  remotePort?: number;
  /** Dev override: install the daemon from this local tarball. */
  tarball?: string;
  assetsDir: string;
  noUpgrade?: boolean;
  logger?: Logger;
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

  const tunnel = await openTunnel(ssh, remotePort, { sshBinary: opts.sshBinary, logger });
  const client = new DaemonClient(tunnel.localPort, endpoint.token);
  tunnel.onPortChange((port) => client.setPort(port));

  const daemon = await runHandshake({
    client,
    noUpgrade: opts.noUpgrade,
    upgradeDaemon: makeUpgrader(ssh, client, bootstrap),
    logger,
  });

  const ui = await startUiServer({
    assetsDir: opts.assetsDir,
    port: opts.port,
    strictPort: opts.port !== undefined,
    // Never squat the daemon's canonical port either: a local `puddle start`
    // probing 7434 must not find this cockpit's proxy answering for a
    // different (remote) daemon.
    avoidPort: endpoint.port,
    target: { host: '127.0.0.1', port: tunnel.localPort },
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
