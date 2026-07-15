import type { VersionResponse } from '@puddle/shared';
import { installDaemon, installedVersion, type BootstrapOptions } from './bootstrap.js';
import { DaemonClient, readDaemonPort, readToken, waitForToken } from './daemon-client.js';
import { sleep } from './net.js';
import type { Transport } from './transport/transport.js';
import { CliError, type CliEvent, type Logger, silentLogger } from './types.js';

/**
 * A running cockpit: the UI server (and tunnel, in SSH mode) behind one
 * handle. This is the seam a future desktop shell builds on — stop() closes
 * only client-side pieces; the daemon and its agents keep running.
 */
export interface RunningCockpit {
  origin: string;
  /** origin + ?host= (SSH mode) + #token= — what the browser opens. */
  browserUrl: string;
  /** The UI server's per-instance identity (see UiServer.nonce). */
  nonce: string;
  daemon: VersionResponse;
  onEvent(cb: (e: CliEvent) => void): () => void;
  stop(): Promise<void>;
}

export interface DaemonEndpoint {
  /** The daemon's own port on its host (not a tunnel port). */
  port: number;
  token: string;
  /** True when this call installed or restarted the daemon. */
  bootstrapped: boolean;
}

/**
 * Make sure a daemon is installed and answering on its host, installing or
 * restarting via the embedded install.sh when needed; returns its port and
 * token. `probe` must check reachability of the daemon's OWN port on its
 * host (from the host itself), since the tunnel may not exist yet.
 */
export async function ensureDaemon(
  transport: Transport,
  opts: BootstrapOptions & { logger?: Logger },
): Promise<DaemonEndpoint> {
  const logger = opts.logger ?? silentLogger;
  let bootstrapped = false;

  let token = await readToken(transport);
  if (token === null) {
    // Never installed (or never started): first-time bootstrap.
    await installDaemon(transport, opts);
    bootstrapped = true;
    token = await waitForToken(transport, 20_000);
  }
  let port = await readDaemonPort(transport);

  // The daemon may be installed but stopped (nohup host rebooted, service
  // disabled). Probe from the host itself so this works before any tunnel.
  const probe = await hostProbe(transport, port, token);
  if (probe === 'unauthorised') throw portConflict(transport, port);
  if (probe === 'down') {
    if ((await installedVersion(transport)) === null) {
      // A state dir without a managed install (a dev daemon's leftovers, an
      // interrupted bootstrap): `start`/`connect` promise a running daemon
      // (SPEC §10), so install rather than refuse — ~/.puddle state (db,
      // token, worktrees) is untouched; install.sh only writes bin/ and the
      // supervisor.
      logger.info(`no managed daemon on ${transport.label} — bootstrapping one`);
    } else {
      logger.info(`puddled is installed on ${transport.label} but not running — restarting it`);
    }
    await installDaemon(transport, opts); // idempotent: (re)installs + restarts
    bootstrapped = true;
    port = await readDaemonPort(transport);
    token = (await readToken(transport)) ?? token;
    const after = await waitForHostProbe(transport, port, token, 20_000);
    if (after === 'unauthorised') throw portConflict(transport, port);
    if (after !== 'ok') {
      throw new CliError(
        'daemon_start_timeout',
        `puddled did not come up on ${transport.label}`,
        transport.kind === 'ssh'
          ? `inspect it with: puddle logs ${transport.label}`
          : 'inspect it with: puddle logs',
      );
    }
  }

  return { port, token, bootstrapped };
}

function portConflict(transport: Transport, port: number): CliError {
  return new CliError(
    'port_in_use',
    `something on ${transport.label} answers on 127.0.0.1:${port} but rejects this host's token`,
    `it is probably not this host's daemon — another puddle cockpit's UI server that auto-picked ${port}, ` +
      `or a daemon started before the token changed. Close it (or restart it), or point the daemon at ` +
      `another port in ~/.puddle/config.json.`,
  );
}

type ProbeResult = 'ok' | 'unauthorised' | 'down';

/**
 * Reachability AND identity of the daemon on 127.0.0.1:<port>, checked from
 * its own host: only a 200 with this host's token counts as "our daemon is
 * up". A 401/403 means SOMETHING answers but not our daemon (typically a
 * `puddle connect` UI server that auto-picked the port) — proceeding would
 * silently wire the cockpit to the wrong backend. Node is guaranteed on the
 * host only under ~/.puddle/bin, so this rides curl, degrading to a plain
 * TCP check (bash /dev/tcp) that cannot verify identity.
 */
async function hostProbe(transport: Transport, port: number, token: string): Promise<ProbeResult> {
  const cmd =
    `if command -v curl >/dev/null 2>&1; then ` +
    `curl -s -o /dev/null --max-time 2 -w 'HTTP:%{http_code}' ` +
    `-H 'Authorization: Bearer ${token}' http://127.0.0.1:${port}/api/version || echo DOWN; ` +
    `elif command -v bash >/dev/null 2>&1 && bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port}' 2>/dev/null; ` +
    `then echo TCPOPEN; else echo DOWN; fi`;
  const out = (await transport.exec(cmd, { timeoutMs: 10_000 })).stdout;
  if (out.includes('HTTP:200')) return 'ok';
  if (out.includes('HTTP:401') || out.includes('HTTP:403')) return 'unauthorised';
  if (out.includes('TCPOPEN')) return 'ok'; // no curl on host: cannot verify identity
  return 'down';
}

async function waitForHostProbe(
  transport: Transport,
  port: number,
  token: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const deadline = Date.now() + timeoutMs;
  let last: ProbeResult = 'down';
  while (Date.now() < deadline) {
    last = await hostProbe(transport, port, token);
    if (last !== 'down') return last;
    await sleep(500);
  }
  return last;
}

/** Build the client-facing upgrade callback the handshake needs. */
export function makeUpgrader(
  transport: Transport,
  client: DaemonClient,
  opts: BootstrapOptions & { logger?: Logger },
): () => Promise<void> {
  return async () => {
    await installDaemon(transport, opts);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await client.responds()) return;
      await sleep(500);
    }
    throw new CliError(
      'daemon_start_timeout',
      `puddled did not come back after updating on ${transport.label}`,
    );
  };
}
