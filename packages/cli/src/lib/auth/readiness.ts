import { inspectHost } from './control-channel.js';
import type { HostInspection } from '@puddle/shared';
import { acquireAuthority, type HostConnection } from './connection-authority.js';
import type { Transport } from '../transport/transport.js';
import { sleep } from '../transport/net.js';
import { CliError } from '../types.js';

/** Wait for authenticated host control readiness, never a TCP/401 probe. */
export async function waitForStartedDaemon(
  transport: Transport,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ port: number; authority: HostConnection }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal?.aborted) {
    try {
      const authority = await acquireAuthority(transport);
      if (signal?.aborted) {
        authority.close();
        throw startTimeout(transport);
      }
      return { port: authority.port, authority };
    } catch (err) {
      if (err instanceof CliError && err.code === 'protocol_mismatch') throw err;
    }
    await sleep(500);
  }
  throw startTimeout(transport);
}

/** Trusted host-side inspection can precede a major-version upgrade; it exposes no API token. */
export async function waitForInspectedDaemon(
  transport: Transport,
  timeoutMs: number,
): Promise<HostInspection> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const inspection = await inspectHost(transport);
      if (inspection) return inspection;
    } catch {
      // The selected service may still be starting. Never dispatch another start.
    }
    await sleep(500);
  }
  throw startTimeout(transport);
}

function startTimeout(transport: Transport): CliError {
  return new CliError(
    'daemon_start_timeout',
    `puddled did not come up on ${transport.label}`,
    transport.kind === 'ssh'
      ? `inspect it with: puddle logs ${transport.label}`
      : 'inspect it with: puddle logs',
  );
}
