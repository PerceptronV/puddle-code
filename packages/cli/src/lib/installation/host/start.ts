import { hostPaths } from '../../paths.js';
import type { Transport } from '../../transport/transport.js';
import { waitForStartedDaemon } from '../../auth/readiness.js';
import { CliError } from '../../types.js';

/** Trusted OS/SSH request only; readiness, not an exit code, establishes a usable daemon. */
export async function startInstalledDaemon(transport: Transport, timeoutMs = 20_000) {
  try {
    await transport.exec(
      `${hostPaths.current}/bin/node ${hostPaths.current}/daemon/host-update.mjs ` +
        `--home ${hostPaths.home} --start-daemon`,
      { timeoutMs: 120_000 },
    );
  } catch {
    // A failed channel may have lost a successful supervisor reply. Observe once
    // through authenticated readiness; never retry startup or fall back to install.
  }
  try {
    return await waitForStartedDaemon(transport, timeoutMs);
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== 'daemon_start_timeout') throw error;
    throw new CliError(
      'daemon_start_timeout',
      `The selected puddled service did not become ready on ${transport.label}`,
      'Inspect puddle updates and puddle logs on this host; unfinished updates require explicit recovery',
    );
  }
}
