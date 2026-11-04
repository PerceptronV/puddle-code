import { installDaemon, installedVersion, type BootstrapOptions } from './bootstrap.js';
import { inspectHost } from '../auth/control-channel.js';
import type { Transport } from '../transport/transport.js';
import { CliError, type Logger, silentLogger } from '../types.js';
import { pinnedDaemonVersion } from '../version.js';
import { hostPaths } from '../paths.js';
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

  const inspection = await inspectHost(transport);
  const protocol = inspection?.version.protocol;
  if (protocol && (protocol.major > 25 || (protocol.major === 25 && protocol.minor >= 7))) {
    const result = await upgradeHostComponent(transport, 'daemon', {
      ...opts,
      version: opts.version ?? pinnedDaemonVersion(),
    });
    return { from: result.from, to: result.to, liveSessions: inspection.liveSessions };
  }
  // An absent connection is not permission to bypass a modern host's coordinator.
  // Passive file presence is sufficient to refuse bootstrap, never to permit activation.
  const metadata = await transport.exec(
    `if [ -e ${hostPaths.current}/HOST_CAPABILITIES.json ] || ` +
      `[ -L ${hostPaths.current}/HOST_CAPABILITIES.json ] || ` +
      `[ -e ${hostPaths.home}/bin/runtime-current ] || [ -L ${hostPaths.home}/bin/runtime-current ] || ` +
      `[ -e ${hostPaths.home}/updates/operations.json ] || [ -L ${hostPaths.home}/updates/operations.json ]; ` +
      `then exit 0; else exit 3; fi`,
    { timeoutMs: 15_000 },
  );
  if (metadata.code !== 3)
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
