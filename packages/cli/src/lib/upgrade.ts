import { installDaemon, installedVersion, type BootstrapOptions } from './bootstrap.js';
import { DaemonClient, readDaemonPort, readToken } from './daemon-client.js';
import type { Transport } from './transport/transport.js';
import { type Logger, silentLogger } from './types.js';
import { pinnedDaemonVersion } from './version.js';

export interface UpgradeResult {
  from: string | null;
  to: string;
  liveSessions: number;
}

/**
 * Unconditional daemon reinstall to the CLI's pinned version — `puddle
 * upgrade` (SPEC §6: never required within a protocol major, always
 * available). Prints the interruption count first via the returned data.
 */
export async function upgradeDaemon(
  transport: Transport,
  opts: BootstrapOptions & { logger?: Logger; probeLive?: boolean } = {},
): Promise<UpgradeResult> {
  const logger = opts.logger ?? silentLogger;
  const from = await installedVersion(transport);

  let liveSessions = 0;
  const token = await readToken(transport);
  if (token !== null && transport.kind === 'local') {
    // Local mode can count live sessions directly; over SSH the caller
    // already has a tunnel-aware client when it needs the count.
    const client = new DaemonClient(await readDaemonPort(transport), token);
    liveSessions = await client.liveSessionCount().catch(() => 0);
  }
  if (liveSessions > 0) {
    logger.info(`${liveSessions} live session(s) will be interrupted and can be resumed`);
  }

  await installDaemon(transport, opts);
  return { from, to: opts.version ?? pinnedDaemonVersion(), liveSessions };
}
