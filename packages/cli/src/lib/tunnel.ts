import { spawn, type ChildProcess } from 'node:child_process';
import { findFreePort, sleep, waitForTcp } from './net.js';
import type { SshTransport } from './transport/ssh.js';
import { CliError, type CliEvent, type Logger, silentLogger } from './types.js';

export interface Tunnel {
  /** The forward's local end — pure transport, never user-visible. */
  readonly localPort: number;
  onEvent(cb: (e: CliEvent) => void): () => void;
  /** The port may move if the original is stolen during a reconnect. */
  onPortChange(cb: (port: number) => void): () => void;
  close(): Promise<void>;
}

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 10_000;
/** An outage restored inside this window is a blip, not news (see below). */
const DOWN_GRACE_MS = 2000;
/** A drop this soon after a restore is instability — announce it at once. */
const STABLE_MS = 30_000;

/**
 * `ssh -N -L <localPort>:127.0.0.1:<remotePort>` over the master connection,
 * with auto-reconnect: on child exit the master is checked (re-opened
 * interactively if ControlPersist lapsed — a prompt may reappear, correctly)
 * and the forward respawned on the SAME local port so the UI server's target
 * stays put; only if that port got stolen meanwhile is a new one picked and
 * announced via onPortChange.
 *
 * tunnel-down/tunnel-up are announcements, not raw child-exit telemetry: an
 * outage that heals inside the grace window emits nothing (a keepalive blip
 * respawns on the first attempt, and a lost/restored pair for every blip
 * reads like a broken tunnel) — unless it follows a recent restore, which
 * means flapping and is announced immediately.
 */
export async function openTunnel(
  ssh: SshTransport,
  remotePort: number,
  opts: { sshBinary?: string; logger?: Logger; downGraceMs?: number } = {},
): Promise<Tunnel> {
  const logger = opts.logger ?? silentLogger;
  const sshBinary = opts.sshBinary ?? 'ssh';
  const downGraceMs = opts.downGraceMs ?? DOWN_GRACE_MS;
  const eventCbs = new Set<(e: CliEvent) => void>();
  const portCbs = new Set<(port: number) => void>();
  const emit = (e: CliEvent) => eventCbs.forEach((cb) => cb(e));

  let localPort = await findFreePort();
  // Property access instead of a bare `let`: TS narrows a closure-assigned
  // local to null/never at the call sites below.
  const state: { child: ChildProcess | null } = { child: null };
  let stopping = false;
  let lastRestoredAt = 0;

  // True while a reconnect loop (or the initial spawn) owns the lifecycle:
  // child exits are then that loop's business, never a second loop's.
  let reconnectActive = false;

  const spawnForward = async (port: number): Promise<boolean> => {
    if (stopping) return false;
    const child = spawn(
      sshBinary,
      // ExitOnForwardFailure: a forward that cannot bind must die (and be
      // seen to die) rather than linger as an ssh with no -L behind it.
      ssh.args(
        '-o',
        'ExitOnForwardFailure=yes',
        '-N',
        '-L',
        `${port}:127.0.0.1:${remotePort}`,
        ssh.host,
      ),
      {
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
    child.on('close', () => onChildExit(child));
    state.child = child;
    // Readiness by TCP probe, never by parsing ssh output — and the child
    // must have survived it: something else listening on the port (a squatter
    // after a drop) would otherwise pass the probe on behalf of an ssh that
    // already gave up, wiring the UI to a stranger.
    const ready = (await waitForTcp(port, 5000)) && child.exitCode === null;
    if (!ready) discard(child);
    return ready;
  };

  /**
   * Forget-and-kill a child we gave up on. Forgetting first matters: its
   * close event must not read as an outage — treating self-inflicted kills
   * as drops used to spawn a second reconnect loop racing the first.
   */
  const discard = (child: ChildProcess) => {
    if (state.child === child) state.child = null;
    child.kill('SIGTERM');
  };

  const onChildExit = (child: ChildProcess) => {
    if (stopping || reconnectActive || child !== state.child) return;
    state.child = null;
    void reconnect();
  };

  const reconnect = async () => {
    if (reconnectActive || stopping) return; // set synchronously below — single loop, always
    reconnectActive = true;
    const flapping = lastRestoredAt !== 0 && Date.now() - lastRestoredAt < STABLE_MS;
    let announced = false;
    const announce = () => {
      announced = true;
      emit({ t: 'tunnel-down' });
    };
    const grace = flapping ? null : setTimeout(announce, downGraceMs);
    if (flapping) announce();

    let delay = RECONNECT_INITIAL_MS;
    let restored = false;
    try {
      while (!stopping) {
        await sleep(delay);
        if (stopping) break;
        if (!(await ssh.isAlive())) {
          try {
            // May prompt on the TTY in --foreground mode; a detached cockpit
            // has none, so password/2FA re-auth keeps failing here and the
            // loop keeps retrying — visible in the cockpit log either way.
            await ssh.open();
          } catch {
            delay = Math.min(delay * 2, RECONNECT_MAX_MS);
            continue;
          }
        }
        if (await spawnForward(localPort)) {
          restored = true;
          break;
        }
        // The old port may have been stolen while we were down: try a fresh one.
        const port = await findFreePort();
        if (await spawnForward(port)) {
          localPort = port;
          portCbs.forEach((cb) => cb(port));
          restored = true;
          break;
        }
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
        logger.warn(`tunnel to ${ssh.host} not back yet — retrying`);
      }
    } finally {
      if (grace !== null) clearTimeout(grace);
      reconnectActive = false;
    }
    if (stopping) {
      state.child?.kill('SIGTERM'); // close() may have missed a child adopted mid-loop
      return;
    }
    if (restored) {
      lastRestoredAt = Date.now();
      if (announced) emit({ t: 'tunnel-up' });
      // A death in the instant between adoption and here was swallowed by
      // the reconnectActive guard — recheck rather than trust the window.
      if (state.child === null || state.child.exitCode !== null) {
        state.child = null;
        void reconnect();
      }
    }
  };

  reconnectActive = true; // initial-probe exits must not strand a reconnect loop
  const initialReady = await spawnForward(localPort);
  reconnectActive = false;
  if (!initialReady) {
    stopping = true; // no Tunnel handle will exist — nothing may keep respawning
    throw new CliError(
      'ssh_unreachable',
      `could not open a tunnel to ${ssh.host}:${remotePort}`,
      'is the daemon running on the host? try: puddle status ' + ssh.host,
    );
  }
  if (state.child === null || state.child.exitCode !== null) {
    // Died right after the probe, while exits were being swallowed.
    state.child = null;
    void reconnect();
  }

  return {
    get localPort() {
      return localPort;
    },
    onEvent(cb) {
      eventCbs.add(cb);
      return () => eventCbs.delete(cb);
    },
    onPortChange(cb) {
      portCbs.add(cb);
      return () => portCbs.delete(cb);
    },
    close() {
      stopping = true;
      return new Promise((resolve) => {
        const child = state.child;
        if (child === null || child.exitCode !== null) return resolve();
        child.once('close', () => resolve());
        child.kill('SIGTERM');
      });
    },
  };
}
