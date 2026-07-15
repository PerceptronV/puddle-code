import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachSession } from '../lib/attach.js';
import { openBrowser } from '../lib/browser.js';
import { connectRemote } from '../lib/connect.js';
import { DaemonClient, readDaemonPort, readToken } from '../lib/daemon-client.js';
import { showLogs } from '../lib/logs.js';
import { openTunnel } from '../lib/tunnel.js';
import { startLocal } from '../lib/start.js';
import { statusReport } from '../lib/status.js';
import { LocalTransport } from '../lib/transport/local.js';
import { SshTransport } from '../lib/transport/ssh.js';
import type { Transport } from '../lib/transport/transport.js';
import { CliError } from '../lib/types.js';
import { upgradeDaemon } from '../lib/upgrade.js';
import { cliVersion } from '../lib/version.js';
import { USAGE, type Command } from './args.js';
import { terminalLogger } from './output.js';

/** The built web UI shipped inside this package (dist/public). */
function assetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, 'public'), join(here, '..', '..', 'dist', 'public')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  throw new CliError(
    'not_installed',
    'the web UI assets are missing from this build',
    'run pnpm build first (packages/cli/scripts/build.mjs copies them in)',
  );
}

/**
 * Open a transport + daemon client for the read-only commands
 * (status/attach/logs/upgrade); remote targets get an ephemeral tunnel.
 */
async function openTarget(host: string | undefined) {
  const transport: Transport = host === undefined ? new LocalTransport() : new SshTransport(host);
  if (transport instanceof SshTransport) await transport.open();
  const token = await readToken(transport);
  if (token === null) {
    throw new CliError(
      'not_installed',
      `no puddle daemon is set up on ${transport.label}`,
      host === undefined ? 'run: puddle start' : `run: puddle connect ${host}`,
    );
  }
  const daemonPort = await readDaemonPort(transport);
  let port = daemonPort;
  let tunnel: Awaited<ReturnType<typeof openTunnel>> | null = null;
  if (transport instanceof SshTransport) {
    tunnel = await openTunnel(transport, daemonPort);
    port = tunnel.localPort;
  }
  return {
    transport,
    token,
    port,
    client: new DaemonClient(port, token),
    async close() {
      await tunnel?.close();
      transport.dispose();
    },
  };
}

/** Keep the process alive until Ctrl-C; second Ctrl-C hard-exits. */
function runUntilInterrupted(stop: () => Promise<void>, farewell: string): Promise<void> {
  return new Promise((resolve) => {
    let stopping = false;
    process.on('SIGINT', () => {
      if (stopping) process.exit(130);
      stopping = true;
      process.stderr.write(`\n${farewell}\n`);
      void stop().then(resolve);
    });
    process.on('SIGTERM', () => {
      void stop().then(resolve);
    });
  });
}

export async function run(command: Command): Promise<number> {
  const logger = terminalLogger();

  switch (command.cmd) {
    case 'help':
      process.stdout.write(USAGE + '\n');
      return 0;
    case 'version':
      process.stdout.write(`puddle ${cliVersion()}\n`);
      return 0;

    case 'start': {
      const cockpit = await startLocal({ ...command, assetsDir: assetsDir(), logger });
      logger.info(`puddle cockpit at ${cockpit.origin} (daemon ${cockpit.daemon.version})`);
      if (!command.noBrowser) openBrowser(cockpit.browserUrl);
      logger.info(`open: ${cockpit.browserUrl}`);
      await runUntilInterrupted(
        cockpit.stop,
        'cockpit closed — sessions keep running on this machine',
      );
      return 0;
    }

    case 'connect': {
      const cockpit = await connectRemote({ ...command, assetsDir: assetsDir(), logger });
      logger.info(
        `puddle cockpit at ${cockpit.origin} → ${command.host} (daemon ${cockpit.daemon.version})`,
      );
      if (!command.noBrowser) openBrowser(cockpit.browserUrl);
      logger.info(`open: ${cockpit.browserUrl}`);
      await runUntilInterrupted(
        cockpit.stop,
        `cockpit closed — sessions keep running on ${command.host}`,
      );
      return 0;
    }

    case 'status': {
      const target = await openTarget(command.host);
      try {
        const report = await statusReport(target.client);
        const where = `${report.host.username}@${report.host.hostname}`;
        process.stdout.write(
          `puddled ${report.daemon.version} (protocol ${report.daemon.protocol.major}.${report.daemon.protocol.minor}) on ${where} — ${report.sessions.length} session(s)\n`,
        );
        for (const s of report.sessions) {
          const title = s.title ?? '(untitled)';
          const agent = s.kind === 'terminal' ? 'terminal' : (s.agent_type ?? 'agent');
          const when = s.last_activity_at ?? s.updated_at;
          process.stdout.write(
            `  ${s.id.slice(0, 8)}  ${pad(s.status, 13)} ${pad(agent, 12)} ${pad(title, 32)} ${when}\n`,
          );
        }
        return 0;
      } finally {
        await target.close();
      }
    }

    case 'attach': {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new CliError('attach_needs_tty', 'attach needs an interactive terminal');
      }
      const target = await openTarget(command.host);
      try {
        const outcome = await attachSession({
          client: target.client,
          port: target.port,
          token: target.token,
          session: command.session,
          ...(command.term !== undefined ? { term: command.term } : {}),
          streams: {
            stdin: process.stdin,
            stdout: process.stdout,
            stderr: process.stderr,
            onResize: (cb) => {
              process.on('SIGWINCH', cb);
              return () => process.off('SIGWINCH', cb);
            },
          },
        });
        switch (outcome.kind) {
          case 'detached':
            logger.info('detached — the session keeps running');
            return 0;
          case 'exited':
            logger.info(`session exited (code ${outcome.code})`);
            return 0;
          case 'connection-lost':
            logger.warn('connection lost');
            return 1;
          case 'error':
            logger.warn(outcome.message);
            return 1;
        }
        return 0;
      } finally {
        await target.close();
      }
    }

    case 'logs': {
      const target = await openTarget(command.host);
      try {
        let session = command.session;
        if (session !== undefined) {
          // Accept the same id prefixes attach does; resolve via the API.
          const { resolveSession } = await import('../lib/attach.js');
          session = (await resolveSession(target.client, session)).id;
        }
        await showLogs(target.transport, {
          ...(session !== undefined ? { session } : {}),
          ...(command.term !== undefined ? { term: command.term } : {}),
          follow: command.follow,
          write: (chunk) => process.stdout.write(chunk),
        });
        return 0;
      } finally {
        await target.close();
      }
    }

    case 'upgrade': {
      const transport: Transport =
        command.host === undefined ? new LocalTransport() : new SshTransport(command.host);
      if (transport instanceof SshTransport) await transport.open();
      try {
        const result = await upgradeDaemon(transport, { logger });
        logger.info(`puddled ${result.from ?? '(unmanaged)'} → ${result.to} on ${transport.label}`);
        return 0;
      } finally {
        transport.dispose();
      }
    }
  }
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width - 1) + '…' : text.padEnd(width);
}
