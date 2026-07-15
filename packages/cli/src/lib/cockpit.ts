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
  if (!(await hostProbe(transport, port))) {
    if ((await installedVersion(transport)) === null) {
      throw new CliError(
        'daemon_unreachable',
        `a puddle state directory exists on ${transport.label} but no managed daemon answers on port ${port}`,
        'a development daemon must be started by hand; otherwise remove ~/.puddle/bin and re-run to bootstrap',
      );
    }
    logger.info(`puddled is installed on ${transport.label} but not running — restarting it`);
    await installDaemon(transport, opts); // idempotent: restarts the supervisor
    bootstrapped = true;
    port = await readDaemonPort(transport);
    if (!(await waitForHostProbe(transport, port, 20_000))) {
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

/** TCP-ish reachability of 127.0.0.1:<port> from the daemon's own host. */
async function hostProbe(transport: Transport, port: number): Promise<boolean> {
  // Node is guaranteed on the host only under ~/.puddle/bin; plain sh tools
  // are not (no nc on minimal boxes). /dev/tcp works in bash; fall back to
  // curl. Both absent → assume unreachable and let bootstrap handle it.
  const cmd =
    `(command -v curl >/dev/null 2>&1 && curl -s -o /dev/null --max-time 2 http://127.0.0.1:${port}/api/version && echo OK) ` +
    `|| (command -v bash >/dev/null 2>&1 && bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port}' 2>/dev/null && echo OK) || true`;
  const result = await transport.exec(cmd, { timeoutMs: 10_000 });
  return result.stdout.includes('OK');
}

async function waitForHostProbe(
  transport: Transport,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hostProbe(transport, port)) return true;
    await sleep(500);
  }
  return false;
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
