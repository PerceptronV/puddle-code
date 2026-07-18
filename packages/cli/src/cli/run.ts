import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachSession } from '../lib/attach.js';
import { openBrowser } from '../lib/browser.js';
import { connectRemote } from '../lib/connect.js';
import { type RunningCockpit } from '../lib/cockpit.js';
import { DaemonClient, readDaemonPort, readToken } from '../lib/daemon-client.js';
import { showLogs } from '../lib/logs.js';
import { waitForHttp } from '../lib/net.js';
import { openTunnel } from '../lib/tunnel.js';
import {
  checkCockpit,
  cockpitLogPath,
  listCockpitRecords,
  readCockpitRecord,
  removeCockpitRecord,
  writeCockpitRecord,
  type CockpitRecord,
} from '../lib/registry.js';
import { startLocal } from '../lib/start.js';
import { statusReport } from '../lib/status.js';
import { LocalTransport } from '../lib/transport/local.js';
import { SshTransport } from '../lib/transport/ssh.js';
import type { Transport } from '../lib/transport/transport.js';
import { CliError, type Logger } from '../lib/types.js';
import { upgradeDaemon } from '../lib/upgrade.js';
import { cliVersion } from '../lib/version.js';
import { argvFor, USAGE, type Command } from './args.js';
import {
  isCockpitChild,
  killHint,
  launchDetached,
  spawnDetachedRefresh,
  terminateCockpit,
} from './detach.js';
import { terminalLogger, timestampedLogger } from './output.js';

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
    tunnel = await openTunnel(transport, daemonPort, {
      ready: (localPort) => waitForHttp(`http://127.0.0.1:${localPort}/api/version`, 8000),
    });
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

    case 'start':
    case 'connect': {
      const target = command.cmd === 'connect' ? command.host : 'local';
      // Background by default: re-exec detached, follow the child's log until
      // its registry record turns ready, then hand the terminal back.
      if (!command.foreground && !isCockpitChild()) {
        return launchDetached({ target, noBrowser: command.noBrowser, logger });
      }
      return runCockpit(command, target, logger);
    }

    case 'refresh': {
      // Resolve the target the way `kill` does: explicit, else the sole cockpit.
      let target = command.target;
      if (target === undefined) {
        const records = listCockpitRecords();
        if (records.length === 1) target = records[0]!.target;
        else if (records.length === 0) {
          throw new CliError(
            'no_cockpit',
            'no cockpits are running — name the target to refresh',
            'puddle refresh <local | user@host>',
          );
        } else {
          throw new CliError(
            'bad_arguments',
            'several cockpits are running — name the one to refresh',
            `puddle refresh <${records.map((r) => r.target).join(' | ')}>`,
          );
        }
      }
      if (target === 'local' && command.remotePort !== undefined) {
        throw new CliError('bad_arguments', '--remote-port only applies to a remote target');
      }

      // Stop the old cockpit first — running, starting, or unverified alike
      // (refresh exists precisely for the wedged ones); a dead record is just
      // pruned. Remember its UI port so the new cockpit lands on the same
      // origin and any open browser tab survives the swap.
      const existing = readCockpitRecord(target);
      let oldPort: number | undefined;
      if (existing !== null) {
        if (existing.origin !== undefined) {
          const parsed = Number(new URL(existing.origin).port);
          if (Number.isInteger(parsed) && parsed > 0) oldPort = parsed;
        }
        if ((await checkCockpit(existing)) === 'dead') {
          removeCockpitRecord(target);
        } else {
          await terminateCockpit(existing);
          logger.info(`stopped the old cockpit for ${target}`);
        }
      }

      const shared = {
        ...(command.port !== undefined ? { port: command.port } : {}),
        ...(command.port === undefined && oldPort !== undefined ? { preferPort: oldPort } : {}),
        ...(command.tarball !== undefined ? { tarball: command.tarball } : {}),
        noBrowser: command.noBrowser,
        noUpgrade: command.noUpgrade,
        foreground: command.foreground,
      };
      const next: Extract<Command, { cmd: 'start' | 'connect' }> =
        target === 'local'
          ? { cmd: 'start', ...shared }
          : {
              cmd: 'connect',
              host: target,
              ...shared,
              ...(command.remotePort !== undefined ? { remotePort: command.remotePort } : {}),
            };

      if (!command.foreground && !isCockpitChild()) {
        // The detached child must run the rebuilt start/connect, not refresh
        // again — hence the explicit argv.
        return launchDetached({
          target,
          noBrowser: command.noBrowser,
          logger,
          argv: argvFor(next),
        });
      }
      return runCockpit(next, target, logger);
    }

    case 'list': {
      const rows: Array<{ record: CockpitRecord; liveness: string }> = [];
      for (const record of listCockpitRecords()) {
        const liveness = await checkCockpit(record);
        if (liveness === 'dead') {
          removeCockpitRecord(record.target); // pid gone — the only safe prune
          continue;
        }
        rows.push({ record, liveness });
      }
      if (rows.length === 0) {
        process.stdout.write('no cockpits are running\n');
        return 0;
      }
      process.stdout.write(
        `${pad('TARGET', 26)} ${pad('STATUS', 9)} ${pad('PID', 7)} ${pad('UI', 24)} STARTED\n`,
      );
      for (const { record, liveness } of rows) {
        process.stdout.write(
          `${pad(record.target, 26)} ${pad(liveness, 9)} ${pad(String(record.pid), 7)} ` +
            `${pad(record.origin ?? '—', 24)} ${record.startedAt}\n`,
        );
      }
      return 0;
    }

    case 'kill': {
      const live: CockpitRecord[] = [];
      for (const record of listCockpitRecords()) {
        if ((await checkCockpit(record)) === 'dead') removeCockpitRecord(record.target);
        else live.push(record); // running, starting, or unverified — all killable
      }
      let victims: CockpitRecord[];
      if (command.all) {
        if (live.length === 0) {
          logger.info('no cockpits are running');
          return 0;
        }
        victims = live;
      } else if (command.target !== undefined) {
        const found = live.find((r) => r.target === command.target);
        if (found === undefined) {
          throw new CliError(
            'no_cockpit',
            `no cockpit is running for ${command.target}`,
            live.length > 0
              ? `running: ${live.map((r) => r.target).join(', ')}`
              : 'see: puddle list',
          );
        }
        victims = [found];
      } else {
        if (live.length === 0) throw new CliError('no_cockpit', 'no cockpits are running');
        if (live.length > 1) {
          throw new CliError(
            'bad_arguments',
            'several cockpits are running — name the one to kill',
            `puddle kill <${live.map((r) => r.target).join(' | ')}>  (or --all)`,
          );
        }
        victims = live;
      }
      for (const victim of victims) {
        await terminateCockpit(victim);
        const where = victim.target === 'local' ? 'this machine' : victim.target;
        logger.info(`stopped the cockpit for ${victim.target} — sessions keep running on ${where}`);
      }
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

/**
 * The cockpit process itself — the detached child, or a --foreground run.
 * Both keep a registry record so `puddle list`/`kill` see them: 'starting'
 * while bootstrapping (what the detached launcher polls), then 'ready' with
 * origin + nonce, or 'error' with the failure relayed to the launcher.
 */
async function runCockpit(
  command: Extract<Command, { cmd: 'start' | 'connect' }>,
  target: string,
  terminal: Logger,
): Promise<number> {
  const detached = isCockpitChild();
  const logger = detached ? timestampedLogger() : terminal;

  const existing = readCockpitRecord(target);
  if (existing !== null && existing.pid !== process.pid) {
    if ((await checkCockpit(existing)) !== 'dead') {
      throw new CliError(
        'already_running',
        `a cockpit for ${target} is already running at ${existing.origin ?? `pid ${existing.pid}`}`,
        killHint(target).replace('stop it', 'stop it first'),
      );
    }
    removeCockpitRecord(target);
  }

  const base: CockpitRecord = {
    target,
    pid: process.pid,
    status: 'starting',
    startedAt: new Date().toISOString(),
    cliVersion: cliVersion(),
    ...(detached ? { logFile: cockpitLogPath(target) } : {}),
  };
  writeCockpitRecord(base);

  // The UI's "refresh connection" button: replace this cockpit wholesale. A
  // detached `puddle refresh` takes over — it stops this process, then starts
  // a fresh cockpit on the same UI port — carrying the original flags so a
  // --tarball/--no-upgrade dev run refreshes into the same configuration.
  const onRefreshRequest = () => {
    logger.info('refresh requested from the UI — replacing this cockpit');
    spawnDetachedRefresh(target, [
      'refresh',
      target,
      '--no-browser', // the requesting tab reloads itself; no second tab
      ...(command.port !== undefined ? ['--port', String(command.port)] : []),
      ...(command.cmd === 'connect' && command.remotePort !== undefined
        ? ['--remote-port', String(command.remotePort)]
        : []),
      ...(command.tarball !== undefined ? ['--tarball', command.tarball] : []),
      ...(command.noUpgrade ? ['--no-upgrade'] : []),
    ]);
  };

  let cockpit: RunningCockpit;
  try {
    cockpit =
      command.cmd === 'start'
        ? await startLocal({ ...command, assetsDir: assetsDir(), logger, onRefreshRequest })
        : await connectRemote({ ...command, assetsDir: assetsDir(), logger, onRefreshRequest });
  } catch (err) {
    if (err instanceof CliError) {
      writeCockpitRecord({
        ...base,
        status: 'error',
        message: err.message,
        ...(err.hint !== undefined ? { hint: err.hint } : {}),
      });
    } else {
      removeCockpitRecord(target);
    }
    throw err;
  }
  writeCockpitRecord({
    ...base,
    status: 'ready',
    origin: cockpit.origin,
    browserUrl: cockpit.browserUrl,
    nonce: cockpit.nonce,
  });

  const arrow = command.cmd === 'connect' ? ` → ${command.host}` : '';
  logger.info(`puddle cockpit at ${cockpit.origin}${arrow} (daemon ${cockpit.daemon.version})`);
  if (!detached) {
    if (!command.noBrowser) openBrowser(cockpit.browserUrl);
    logger.info(`open: ${cockpit.browserUrl}`);
  }

  const where = command.cmd === 'start' ? 'this machine' : command.host;
  await runUntilInterrupted(async () => {
    await cockpit.stop();
    removeCockpitRecord(target);
  }, `cockpit closed — sessions keep running on ${where}`);
  return 0;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width - 1) + '…' : text.padEnd(width);
}
