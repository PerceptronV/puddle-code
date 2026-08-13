import { join } from 'node:path';
import { AttachedDaemon } from './attached-daemon.js';
import { DaemonClient, readDaemonPort } from './daemon-client.js';
import { ensureDaemon, makeUpgrader, type RunningCockpit } from './cockpit.js';
import { runHandshake } from './handshake.js';
import { waitForHttp } from './net.js';
import { clientHome } from './paths.js';
import { startUiServer } from './serve/ui-server.js';
import { openCallbackForward, openTunnel } from './tunnel.js';
import { LocalTransport } from './transport/local.js';
import { SshTransport } from './transport/ssh.js';
import type { CliEvent, Logger } from './types.js';
import { silentLogger } from './types.js';

/**
 * Codex's OAuth login server: a FIXED port baked into its registered
 * `http://localhost:1455/...` redirect URI, so the IdP sends the CLIENT
 * browser there — only a client-side forward can complete it remotely. The
 * other agents need nothing here: claude-code's callback is hosted
 * (platform.claude.com), gemini-cli binds a random loopback port that cannot
 * be forwarded ahead of time (its picker offers API-key auth instead), and
 * opencode takes pasted keys.
 */
const CODEX_OAUTH_PORT = 1455;

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
  /** OpenSSH askpass executable for a graphical embedder with no terminal. */
  sshAskpassProgram?: string;
}

/**
 * SSH mode (SPEC §10): master connection → bootstrap/upgrade the daemon →
 * tunnel → handshake → serve the UI locally with /api + /ws proxied through
 * the tunnel. Ctrl-C (the caller's stop()) closes the tunnel and UI server;
 * supervised daemons keep running, while an attached fallback shuts down
 * cleanly and resumes its interrupted sessions on the next launch.
 */
export async function connectRemote(opts: ConnectOptions): Promise<RunningCockpit> {
  const logger = opts.logger ?? silentLogger;
  const platform = opts.platform ?? process.platform;
  const ssh = new SshTransport(opts.host, {
    sshBinary: opts.sshBinary,
    scpBinary: opts.scpBinary,
    platform,
    askpassProgram: opts.sshAskpassProgram,
  });
  if (platform === 'win32') {
    logger.warn(
      'Windows OpenSSH cannot share a connection; you may be asked to authenticate more than once. ' +
        'An SSH key (ssh-copy-id) avoids the prompts.',
    );
  }
  await ssh.open();

  let tunnelResource: Awaited<ReturnType<typeof openTunnel>> | undefined;
  let oauthForwardResource: Awaited<ReturnType<typeof openCallbackForward>> | undefined;
  let uiResource: Awaited<ReturnType<typeof startUiServer>> | undefined;
  let endpointResource: Awaited<ReturnType<typeof ensureDaemon>> | undefined;

  try {
    const bootstrap = { tarball: opts.tarball, logger };
    const attachedDaemon = new AttachedDaemon(ssh, logger);
    const endpoint = await ensureDaemon(ssh, {
      ...bootstrap,
      attachedFallback: () => attachedDaemon.start(),
    });
    endpointResource = endpoint;
    const remotePort = opts.remotePort ?? endpoint.port;

    // Readiness is the daemon answering /api/version through the forward — any
    // HTTP status proves the byte path (the authenticated handshake follows).
    const tunnel = await openTunnel(ssh, remotePort, {
      sshBinary: opts.sshBinary,
      logger,
      ready: async (localPort) => {
        await endpoint.lease?.ensureRunning();
        return waitForHttp(`http://127.0.0.1:${localPort}/api/version`, 8000);
      },
    });
    tunnelResource = tunnel;
    const client = new DaemonClient(tunnel.localPort, endpoint.token);
    tunnel.onPortChange((port) => client.setPort(port));

    // Carry the client's localhost:1455 to the host for the cockpit's lifetime,
    // so the login URL a remote codex prints works AS PRINTED — clicked or
    // pasted — and the IdP's callback to the client lands on codex's login
    // server. Best-effort by design; the cockpit works fully without it.
    const oauthForward = await openCallbackForward(ssh, CODEX_OAUTH_PORT, {
      sshBinary: opts.sshBinary,
      logger,
    });
    oauthForwardResource = oauthForward;

    const daemon = await runHandshake({
      client,
      noUpgrade: opts.noUpgrade,
      upgradeDaemon: makeUpgrader(ssh, client, bootstrap, endpoint.lease),
      logger,
    });

    // Never squat the port a local `puddle launch` will probe for its own daemon,
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
      // The store lives on the CLIENT machine — every cockpit here shares it,
      // whichever remote daemon each one drives.
      localSync: { token: endpoint.token, file: join(clientHome(), 'local-sync.json') },
    });
    uiResource = ui;
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
      daemonLifetime: endpoint.daemonLifetime,
      onEvent(cb) {
        eventCbs.add(cb);
        return () => eventCbs.delete(cb);
      },
      async stop() {
        await closeRemoteResources(ui, oauthForward, endpoint, tunnel, ssh);
      },
    };
  } catch (err) {
    try {
      await closeRemoteResources(
        uiResource,
        oauthForwardResource,
        endpointResource,
        tunnelResource,
        ssh,
      );
    } catch {
      // Preserve the setup failure; cleanup errors are secondary here.
    }
    throw err;
  }
}

async function closeRemoteResources(
  ui: Awaited<ReturnType<typeof startUiServer>> | undefined,
  oauthForward: Awaited<ReturnType<typeof openCallbackForward>> | undefined,
  endpoint: Awaited<ReturnType<typeof ensureDaemon>> | undefined,
  tunnel: Awaited<ReturnType<typeof openTunnel>> | undefined,
  ssh: SshTransport,
): Promise<void> {
  const actions: Array<() => void | Promise<void>> = [
    () => ui?.close(),
    () => oauthForward?.(),
    () => endpoint?.lease?.stop(),
    () => tunnel?.close(),
    () => ssh.dispose(),
  ];
  let firstError: unknown;
  for (const action of actions) {
    try {
      await action();
    } catch (err) {
      if (firstError === undefined) firstError = err;
    }
  }
  if (firstError !== undefined) throw firstError;
}
