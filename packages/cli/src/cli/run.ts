import { confirmDaemonUpgrade, confirmHostUpdateInterruption } from './daemon-upgrade-prompt.js';
import type { ConfirmHostUpdateInterruption } from '../lib/installation/host/apply.js';
import { acquireAuthority } from '../lib/auth/connection-authority.js';
import { runRemote } from './remote.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachSession } from '../lib/connection/attach.js';
import { openBrowser } from '../lib/serve/browser.js';
import {
  formatComponentVersions,
  installedComponentVersions,
} from '../lib/installation/component-versions.js';
import { connectRemote } from '../lib/connection/connect.js';
import { type RunningFrontend } from '../lib/connection/frontend.js';
import { DaemonClient, readDaemonPort } from '../lib/connection/daemon-client.js';
import { showLogs } from '../lib/logs.js';
import { waitForHttp } from '../lib/transport/net.js';
import { openTunnel } from '../lib/transport/tunnel.js';
import {
  checkFrontend,
  frontendLogPath,
  listFrontendRecords,
  readFrontendRecord,
  removeFrontendRecord,
  writeFrontendRecord,
  type FrontendRecord,
} from '../lib/registry.js';
import { startLocal } from '../lib/connection/start.js';
import { statusReport } from '../lib/connection/status.js';
import { LocalTransport } from '../lib/transport/local.js';
import { SshTransport } from '../lib/transport/ssh.js';
import type { Transport } from '../lib/transport/transport.js';
import { CliError, type Logger } from '../lib/types.js';
import { cliVersion } from '../lib/version.js';
import { argvFor, USAGE, type Command } from './args.js';
import { runInstall, runRemove, runUpgrade } from './manage.js';
import { runUpdates } from './management/updates.js';
import {
  isFrontendChild,
  killHint,
  launchDetached,
  spawnDetachedRefresh,
  terminateFrontend,
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
  const authority = await acquireAuthority(transport);
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
    authority,
    port,
    client: new DaemonClient(port, authority),
    async close() {
      authority.close();
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
    case 'remote':
      return runRemote(command);
    case 'help':
      process.stdout.write(USAGE + '\n');
      return 0;
    case 'version':
      process.stdout.write(`${formatComponentVersions(await installedComponentVersions())}\n`);
      return 0;

    case 'launch': {
      const target = command.target;
      // Background by default: re-exec detached, follow the child's log until
      // its registry record turns ready, then hand the terminal back.
      if (!command.foreground && !isFrontendChild()) {
        return launchDetached({ target, noBrowser: command.noBrowser, logger });
      }
      return runFrontend(command, target, logger);
    }

    case 'refresh': {
      // Resolve the target the way `kill` does: explicit, else the sole frontend.
      let target = command.target;
      if (target === undefined) {
        const records = listFrontendRecords();
        if (records.length === 1) target = records[0]!.target;
        else if (records.length === 0) {
          throw new CliError(
            'no_frontend',
            'no frontends are running — name the target to refresh',
            'puddle refresh <local | user@host>',
          );
        } else {
          throw new CliError(
            'bad_arguments',
            'several frontends are running — name the one to refresh',
            `puddle refresh <${records.map((r) => r.target).join(' | ')}>`,
          );
        }
      }
      if (target === 'local' && command.remotePort !== undefined) {
        throw new CliError('bad_arguments', '--remote-port only applies to a remote target');
      }

      // Stop the old frontend first — running, starting, or unverified alike
      // (refresh exists precisely for the wedged ones); a dead record is just
      // pruned. Remember its UI port so the new frontend lands on the same
      // origin and any open browser tab survives the swap.
      const existing = readFrontendRecord(target);
      let oldPort: number | undefined;
      if (existing !== null) {
        if (existing.origin !== undefined) {
          const parsed = Number(new URL(existing.origin).port);
          if (Number.isInteger(parsed) && parsed > 0) oldPort = parsed;
        }
        if ((await checkFrontend(existing)) === 'dead') {
          removeFrontendRecord(target);
        } else {
          await terminateFrontend(existing);
          logger.info(`stopped the old frontend for ${target}`);
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
      const next: Extract<Command, { cmd: 'launch' }> = {
        cmd: 'launch',
        target,
        ...shared,
        ...(target !== 'local' && command.remotePort !== undefined
          ? { remotePort: command.remotePort }
          : {}),
      };

      if (!command.foreground && !isFrontendChild()) {
        // The detached child must run the rebuilt launch, not refresh
        // again — hence the explicit argv.
        return launchDetached({
          target,
          noBrowser: command.noBrowser,
          logger,
          argv: argvFor(next),
        });
      }
      return runFrontend(next, target, logger);
    }

    case 'list': {
      const rows: Array<{ record: FrontendRecord; liveness: string }> = [];
      for (const record of listFrontendRecords()) {
        const liveness = await checkFrontend(record);
        if (liveness === 'dead') {
          removeFrontendRecord(record.target); // pid gone — the only safe prune
          continue;
        }
        rows.push({ record, liveness });
      }
      if (rows.length === 0) {
        process.stdout.write('no frontends are running\n');
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
      const live: FrontendRecord[] = [];
      for (const record of listFrontendRecords()) {
        if ((await checkFrontend(record)) === 'dead') removeFrontendRecord(record.target);
        else live.push(record); // running, starting, or unverified — all killable
      }
      let victims: FrontendRecord[];
      if (command.all) {
        if (live.length === 0) {
          logger.info('no frontends are running');
          return 0;
        }
        victims = live;
      } else if (command.target !== undefined) {
        const found = live.find((r) => r.target === command.target);
        if (found === undefined) {
          throw new CliError(
            'no_frontend',
            `no frontend is running for ${command.target}`,
            live.length > 0
              ? `running: ${live.map((r) => r.target).join(', ')}`
              : 'see: puddle list',
          );
        }
        victims = [found];
      } else {
        if (live.length === 0) throw new CliError('no_frontend', 'no frontends are running');
        if (live.length > 1) {
          throw new CliError(
            'bad_arguments',
            'several frontends are running — name the one to kill',
            `puddle kill <${live.map((r) => r.target).join(' | ')}>  (or --all)`,
          );
        }
        victims = live;
      }
      for (const victim of victims) {
        await terminateFrontend(victim);
        const where = victim.target === 'local' ? 'this machine' : victim.target;
        logger.info(
          victim.daemonLifetime === 'frontend'
            ? `stopped the frontend for ${victim.target} — daemon data remains on ${where}; interrupted sessions can resume on the next launch`
            : `stopped the frontend for ${victim.target} — sessions keep running on ${where}`,
        );
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
          authority: target.authority,
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
          const { resolveSession } = await import('../lib/connection/attach.js');
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

    case 'install':
      return runInstall(command, logger);
    case 'updates':
      return runUpdates(command, logger);
    case 'upgrade':
      return runUpgrade(command, logger);
    case 'remove':
      return runRemove(command, logger);
  }
}

/**
 * The frontend process itself — the detached child, or a --foreground run.
 * Both keep a registry record so `puddle list`/`kill` see them: 'starting'
 * while bootstrapping (what the detached launcher polls), then 'ready' with
 * origin + nonce, or 'error' with the failure relayed to the launcher.
 */
async function runFrontend(
  command: Extract<Command, { cmd: 'launch' }>,
  target: string,
  terminal: Logger,
): Promise<number> {
  const detached = isFrontendChild();
  const logger = detached ? timestampedLogger() : terminal;

  const existing = readFrontendRecord(target);
  if (existing !== null && existing.pid !== process.pid) {
    if ((await checkFrontend(existing)) !== 'dead') {
      throw new CliError(
        'already_running',
        `a frontend for ${target} is already running at ${existing.origin ?? `pid ${existing.pid}`}`,
        killHint(target).replace('stop it', 'stop it first'),
      );
    }
    removeFrontendRecord(target);
  }

  const base: FrontendRecord = {
    target,
    pid: process.pid,
    status: 'starting',
    startedAt: new Date().toISOString(),
    cliVersion: cliVersion(),
    ...(detached ? { logFile: frontendLogPath(target) } : {}),
  };
  writeFrontendRecord(base);

  // The UI's "refresh connection" button: replace this frontend wholesale. A
  // detached `puddle refresh` takes over — it stops this process, then starts
  // a fresh frontend on the same UI port — carrying the original flags so a
  // --tarball/--no-upgrade dev run refreshes into the same configuration.
  const onRefreshRequest = (refreshId: string) => {
    logger.info('refresh requested from the UI — replacing this frontend');
    spawnDetachedRefresh(
      target,
      [
        'refresh',
        target,
        '--no-browser', // the requesting tab reloads itself; no second tab
        ...(command.port !== undefined ? ['--port', String(command.port)] : []),
        ...(command.remotePort !== undefined ? ['--remote-port', String(command.remotePort)] : []),
        ...(command.tarball !== undefined ? ['--tarball', command.tarball] : []),
        ...(command.noUpgrade ? ['--no-upgrade'] : []),
      ],
      refreshId,
    );
  };

  let frontend: RunningFrontend;
  try {
    const common = {
      ...command,
      assetsDir: assetsDir(),
      confirmDaemonUpgrade,
      confirmInterruption: ((request) =>
        confirmHostUpdateInterruption(
          command.target,
          request,
        )) satisfies ConfirmHostUpdateInterruption,
      logger,
      onRefreshRequest,
      refreshId: process.env.PUDDLE_REFRESH_ID,
    };
    frontend =
      command.target === 'local'
        ? await startLocal(common)
        : await connectRemote({ ...common, host: command.target });
  } catch (err) {
    if (err instanceof CliError) {
      writeFrontendRecord({
        ...base,
        status: 'error',
        message: err.message,
        ...(err.hint !== undefined ? { hint: err.hint } : {}),
      });
    } else {
      removeFrontendRecord(target);
    }
    throw err;
  }
  writeFrontendRecord({
    ...base,
    status: 'ready',
    origin: frontend.origin,
    launcherPath: frontend.launcherPath,
    nonce: frontend.nonce,
    daemonLifetime: frontend.daemonLifetime,
  });

  const arrow = command.target === 'local' ? '' : ` → ${command.target}`;
  logger.info(`Puddle frontend at ${frontend.origin}${arrow} (daemon ${frontend.daemon.version})`);
  if (!detached && process.env.PUDDLE_INTERNAL_REFRESH !== '1') {
    const url = frontend.createInvitation();
    if (command.noBrowser) logger.info(`open: ${url}`);
    else openBrowser(url);
  }

  const where = command.target === 'local' ? 'this machine' : command.target;
  await runUntilInterrupted(
    async () => {
      await frontend.stop();
      removeFrontendRecord(target);
    },
    frontend.daemonLifetime === 'frontend'
      ? `frontend closed — daemon data remains on ${where}; interrupted sessions can resume on the next launch`
      : `frontend closed — sessions keep running on ${where}`,
  );
  return 0;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width - 1) + '…' : text.padEnd(width);
}
