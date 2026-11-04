import { installDaemon, installedVersion, type BootstrapOptions } from './bootstrap.js';
import { inspectHost } from '../auth/control-channel.js';
import type { Transport } from '../transport/transport.js';
import { CliError, type Logger, silentLogger } from '../types.js';
import { pinnedDaemonVersion } from '../version.js';
import { hasPersistentHostInstallation } from './host/presence.js';
import { startInstalledDaemon } from './host/start.js';
import { upgradeHostComponent } from './host/upgrade.js';
import type { ConfirmHostUpdateInterruption } from './host/apply.js';

export interface UpgradeResult {
  from: string | null;
  to: string;
  liveSessions: number;
}

/**
 * Explicit daemon update. Hosts with independent runtimes must own their update
 * transaction; the embedded bootstrap remains the first-install/legacy transition.
 */
export async function upgradeDaemon(
  transport: Transport,
  opts: BootstrapOptions & {
    logger?: Logger;
    confirmInterruption?: ConfirmHostUpdateInterruption;
  } = {},
): Promise<UpgradeResult> {
  const logger = opts.logger ?? silentLogger;
  const from = await installedVersion(transport);

  let inspection = await inspectHost(transport).catch(async (error: unknown) => {
    // A fresh SSH target has no bundled Node with which to stage the inspection
    // helper. Only a genuinely absent installation may bootstrap after that failure.
    if (
      from !== null ||
      error instanceof CliError ||
      (await hasPersistentHostInstallation(transport))
    )
      throw error;
    return null;
  });
  if (!inspection && (await hasPersistentHostInstallation(transport))) {
    logger.info(`starting the selected puddled service on ${transport.label} before updating`);
    const started = await startInstalledDaemon(transport);
    try {
      inspection = await inspectHost(transport);
      if (!inspection)
        throw new CliError('daemon_unreachable', 'The started daemon could not be inspected');
    } finally {
      started.authority.close();
    }
  }
  const protocol = inspection?.version.protocol;
  if (
    inspection &&
    protocol &&
    (protocol.major > 25 || (protocol.major === 25 && protocol.minor >= 7))
  ) {
    const result = await upgradeHostComponent(transport, 'daemon', {
      ...opts,
      version: opts.version ?? pinnedDaemonVersion(),
    });
    return { from: result.from, to: result.to, liveSessions: inspection.liveSessions };
  }
  // An absent connection is not permission to bypass a modern host's coordinator.
  // Passive file presence is sufficient to refuse bootstrap, never to permit activation.
  if (await hasPersistentHostInstallation(transport))
    throw new CliError(
      'daemon_unreachable',
      'The installed host update coordinator is unavailable',
      'Inspect puddle updates on this host; use --operation <id> --continue for supported interrupted updates',
    );
  const liveSessions = inspection?.liveSessions ?? 0;
  if (liveSessions > 0) {
    logger.info(`${liveSessions} live session(s) will be interrupted and can be resumed`);
  }

  await installDaemon(transport, opts);
  return { from, to: opts.version ?? pinnedDaemonVersion(), liveSessions };
}
