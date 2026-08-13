import type { VersionResponse } from '@puddle/shared';
import { installDaemon, installedVersion, type BootstrapOptions } from './bootstrap.js';
import { DaemonClient, readDaemonPort, readToken, waitForToken } from './daemon-client.js';
import { sleep } from './net.js';
import { hostPaths } from './paths.js';
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
  /** Whether puddled outlives this cockpit or is held by its SSH connection. */
  daemonLifetime: 'persistent' | 'cockpit';
  onEvent(cb: (e: CliEvent) => void): () => void;
  stop(): Promise<void>;
}

export interface DaemonLease {
  /** Re-establish the attached daemon after the SSH connection itself recovers. */
  ensureRunning(): Promise<void>;
  /** Cleanly stop the daemon before closing the cockpit's SSH connection. */
  stop(): Promise<void>;
}

export interface DaemonEndpoint {
  /** The daemon's own port on its host (not a tunnel port). */
  port: number;
  token: string;
  /** True when this call installed or restarted the daemon. */
  bootstrapped: boolean;
  /** Persistent supervisor, or an SSH channel owned by this cockpit. */
  daemonLifetime: 'persistent' | 'cockpit';
  /** Present only when daemonLifetime is `cockpit`. */
  lease?: DaemonLease;
}

/**
 * Make sure a daemon is installed and answering on its host, installing or
 * restarting via the embedded install.sh when needed; returns its port and
 * token. `probe` must check reachability of the daemon's OWN port on its
 * host (from the host itself), since the tunnel may not exist yet.
 */
export async function ensureDaemon(
  transport: Transport,
  opts: BootstrapOptions & {
    logger?: Logger;
    /** SSH-only recovery for hosts that reap a detached nohup child. */
    attachedFallback?: () => Promise<DaemonEndpoint>;
    /** Test seam; normal launches use five seconds with a fallback, twenty without. */
    startTimeoutMs?: number;
  },
): Promise<DaemonEndpoint> {
  const logger = opts.logger ?? silentLogger;
  const startTimeoutMs =
    opts.startTimeoutMs ?? (opts.attachedFallback === undefined ? 20_000 : 5_000);
  let bootstrapped = false;

  const token = await readToken(transport);
  if (token === null) {
    // Never installed (or never started): first-time bootstrap. The daemon
    // writes runtime.json only once it has bound, so wait for it to answer
    // rather than probe a port it may not be listening on yet.
    await installDaemon(transport, opts);
    bootstrapped = true;
    return waitAfterInstall(transport, opts, logger, bootstrapped, startTimeoutMs);
  }

  // Installed and holding a token: probe the discoverable port once — the fast
  // path for an already-running daemon.
  const port = await readDaemonPort(transport);
  const probe = await hostProbe(transport, port, token);
  if (probe === 'unauthorised') throw portConflict(transport, port);
  if (probe === 'down') {
    // The daemon may be installed but stopped (nohup host rebooted, service
    // disabled).
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
    return waitAfterInstall(transport, opts, logger, bootstrapped, startTimeoutMs);
  }

  return { port, token, bootstrapped, daemonLifetime: 'persistent' };
}

async function waitAfterInstall(
  transport: Transport,
  opts: { attachedFallback?: () => Promise<DaemonEndpoint> },
  logger: Logger,
  bootstrapped: boolean,
  timeoutMs: number,
): Promise<DaemonEndpoint> {
  try {
    const started = await waitForStartedDaemon(transport, timeoutMs);
    return { ...started, bootstrapped, daemonLifetime: 'persistent' };
  } catch (err) {
    if (
      !(err instanceof CliError) ||
      err.code !== 'daemon_start_timeout' ||
      opts.attachedFallback === undefined ||
      !(await detachedNohupWasReaped(transport))
    ) {
      throw err;
    }
    logger.warn(
      `puddled could not stay detached on ${transport.label} — keeping it attached to this cockpit; ` +
        'session state stays on disk and can resume on the next launch',
    );
    return opts.attachedFallback();
  }
}

/**
 * A fallback is safe only when install.sh explicitly selected nohup and its
 * recorded child is no longer alive. A live-but-unhealthy process or a real
 * supervisor must be diagnosed, never joined by a competing daemon.
 */
async function detachedNohupWasReaped(transport: Transport): Promise<boolean> {
  if (transport.kind !== 'ssh') return false;
  const supervisor = (await transport.readFile(hostPaths.supervisor))?.trim();
  if (supervisor !== 'nohup') return false;
  const rawPid = (await transport.readFile(hostPaths.pid))?.trim() ?? '';
  if (!/^[1-9][0-9]*$/.test(rawPid)) return true;
  const probe = await transport.exec(`kill -0 ${rawPid}`, { timeoutMs: 5000 });
  return probe.code !== 0;
}

/** Wait for a freshly spawned daemon's token and authenticated host-local API. */
export async function waitForStartedDaemon(
  transport: Transport,
  timeoutMs: number,
): Promise<{ port: number; token: string }> {
  const token = await waitForToken(transport, timeoutMs);
  const up = await waitForHostProbe(transport, token, timeoutMs);
  if (up.result === 'unauthorised') throw portConflict(transport, up.port);
  if (up.result !== 'ok') throw startTimeout(transport);
  return { port: up.port, token };
}

function startTimeout(transport: Transport): CliError {
  return new CliError(
    'daemon_start_timeout',
    `puddled did not come up on ${transport.label}`,
    transport.kind === 'ssh'
      ? `inspect it with: puddle logs ${transport.label}`
      : 'inspect it with: puddle logs',
  );
}

function portConflict(transport: Transport, port: number): CliError {
  return new CliError(
    'port_in_use',
    `something on ${transport.label} answers on 127.0.0.1:${port} but rejects this host's token`,
    `it is probably not this host's daemon — another Puddle cockpit's UI server that auto-picked ${port}, ` +
      `or a daemon started before the token changed. Close it (or restart it), or point the daemon at ` +
      `another port in ~/.puddle/config.json.`,
  );
}

type ProbeResult = 'ok' | 'unauthorised' | 'down';

/**
 * Reachability AND identity of the daemon on 127.0.0.1:<port>, checked from
 * its own host: only a 200 with this host's token counts as "our daemon is
 * up". A 401/403 means SOMETHING answers but not our daemon (typically a
 * `puddle launch` UI server that auto-picked the port) — proceeding would
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
  token: string,
  timeoutMs: number,
): Promise<{ result: ProbeResult; port: number }> {
  const deadline = Date.now() + timeoutMs;
  let last: ProbeResult = 'down';
  let port = await readDaemonPort(transport);
  while (Date.now() < deadline) {
    // Re-read every pass: the daemon writes runtime.json only after it binds,
    // and it may have fallen back off the configured port onto a free one.
    port = await readDaemonPort(transport);
    last = await hostProbe(transport, port, token);
    if (last !== 'down') return { result: last, port };
    await sleep(500);
  }
  return { result: last, port };
}

/** Build the client-facing upgrade callback the handshake needs. */
export function makeUpgrader(
  transport: Transport,
  client: DaemonClient,
  opts: BootstrapOptions & { logger?: Logger },
  lease?: DaemonLease,
): () => Promise<void> {
  return async () => {
    await installDaemon(transport, opts);
    // install.sh restarts the selected supervisor. On an attached host that
    // attempt is another reaped nohup child, so restore the cockpit-owned
    // process before waiting for the upgraded API.
    await lease?.ensureRunning();
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
