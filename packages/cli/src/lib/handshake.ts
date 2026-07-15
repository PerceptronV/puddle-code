import { PROTOCOL_VERSION, type VersionResponse } from '@puddle/shared';
import type { DaemonClient } from './daemon-client.js';
import { CliError, type Logger, silentLogger } from './types.js';

export type HandshakeDecision =
  | { kind: 'proceed' }
  | { kind: 'upgrade-daemon' }
  | { kind: 'refuse-cli-outdated'; command: string };

export const CLI_UPGRADE_COMMAND = 'npm install -g @puddle-code/cli';

/**
 * SPEC §6: same protocol major ⇒ compatible both ways (app-version skew is
 * normal and silent). Daemon older ⇒ the CLI updates it. Daemon newer ⇒ the
 * CLI cannot fix itself mid-run and refuses with the exact upgrade command.
 */
export function decideHandshake(
  cli: { major: number },
  daemon: { major: number },
): HandshakeDecision {
  if (daemon.major === cli.major) return { kind: 'proceed' };
  if (daemon.major < cli.major) return { kind: 'upgrade-daemon' };
  return { kind: 'refuse-cli-outdated', command: CLI_UPGRADE_COMMAND };
}

export interface RunHandshakeOptions {
  client: DaemonClient;
  /** Abort instead of auto-updating an older daemon (--no-upgrade). */
  noUpgrade?: boolean;
  /** Re-runs the bootstrap and restarts the daemon (start/connect wire this). */
  upgradeDaemon: (info: { from: string; liveSessions: number }) => Promise<void>;
  logger?: Logger;
}

/** Run the version handshake, auto-upgrading an older-major daemon. */
export async function runHandshake(opts: RunHandshakeOptions): Promise<VersionResponse> {
  const logger = opts.logger ?? silentLogger;
  const daemon = await opts.client.version();
  const decision = decideHandshake(PROTOCOL_VERSION, daemon.protocol);

  if (decision.kind === 'proceed') return daemon;

  if (decision.kind === 'refuse-cli-outdated') {
    throw new CliError(
      'cli_outdated',
      `the daemon speaks protocol ${daemon.protocol.major}; this CLI speaks ${PROTOCOL_VERSION.major}`,
      `update the CLI: ${decision.command}`,
    );
  }

  const liveSessions = await opts.client.liveSessionCount().catch(() => 0);
  if (opts.noUpgrade) {
    throw new CliError(
      'upgrade_failed',
      `the daemon speaks protocol ${daemon.protocol.major} (CLI: ${PROTOCOL_VERSION.major}) and --no-upgrade is set`,
      `re-run without --no-upgrade to update it (${liveSessions} live session(s) would be interrupted and can be resumed)`,
    );
  }

  logger.info(
    `updating puddled (protocol ${daemon.protocol.major} → ${PROTOCOL_VERSION.major}) — ` +
      `${liveSessions} live session(s) will be interrupted and can be resumed`,
  );
  await opts.upgradeDaemon({ from: daemon.version, liveSessions });

  const after = await opts.client.version();
  if (after.protocol.major !== PROTOCOL_VERSION.major) {
    throw new CliError(
      'upgrade_failed',
      `the daemon still speaks protocol ${after.protocol.major} after updating`,
      'inspect the daemon logs: puddle logs',
    );
  }
  return after;
}
