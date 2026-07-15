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

/**
 * `ssh -N -L <localPort>:127.0.0.1:<remotePort>` over the master connection,
 * with auto-reconnect: on child exit the master is checked (re-opened
 * interactively if ControlPersist lapsed — a prompt may reappear, correctly)
 * and the forward respawned on the SAME local port so the UI server's target
 * stays put; only if that port got stolen meanwhile is a new one picked and
 * announced via onPortChange.
 */
export async function openTunnel(
  ssh: SshTransport,
  remotePort: number,
  opts: { sshBinary?: string; logger?: Logger } = {},
): Promise<Tunnel> {
  const logger = opts.logger ?? silentLogger;
  const sshBinary = opts.sshBinary ?? 'ssh';
  const eventCbs = new Set<(e: CliEvent) => void>();
  const portCbs = new Set<(port: number) => void>();
  const emit = (e: CliEvent) => eventCbs.forEach((cb) => cb(e));

  let localPort = await findFreePort();
  // Property access instead of a bare `let`: TS narrows a closure-assigned
  // local to null/never at the call sites below.
  const state: { child: ChildProcess | null } = { child: null };
  let stopping = false;

  const spawnForward = async (port: number): Promise<boolean> => {
    const child = spawn(
      sshBinary,
      ssh.args('-N', '-L', `${port}:127.0.0.1:${remotePort}`, ssh.host),
      {
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
    child.on('close', onChildExit);
    state.child = child;
    // Readiness by TCP probe, never by parsing ssh output.
    return waitForTcp(port, 5000);
  };

  const onChildExit = () => {
    if (stopping) return;
    emit({ t: 'tunnel-down' });
    void reconnect();
  };

  const reconnect = async () => {
    let delay = RECONNECT_INITIAL_MS;
    while (!stopping) {
      await sleep(delay);
      if (stopping) return;
      if (!(await ssh.isAlive())) {
        try {
          await ssh.open(); // may prompt on the inherited TTY — visible and correct
        } catch {
          delay = Math.min(delay * 2, RECONNECT_MAX_MS);
          continue;
        }
      }
      let port = localPort;
      if (await spawnForward(port)) {
        emit({ t: 'tunnel-up' });
        return;
      }
      state.child?.kill();
      // The old port may have been stolen while we were down: try a fresh one.
      port = await findFreePort();
      if (await spawnForward(port)) {
        localPort = port;
        portCbs.forEach((cb) => cb(port));
        emit({ t: 'tunnel-up' });
        return;
      }
      state.child?.kill();
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      logger.warn(`tunnel to ${ssh.host} not back yet — retrying`);
    }
  };

  if (!(await spawnForward(localPort))) {
    state.child?.kill();
    throw new CliError(
      'ssh_unreachable',
      `could not open a tunnel to ${ssh.host}:${remotePort}`,
      'is the daemon running on the host? try: puddle status ' + ssh.host,
    );
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
