import { PROTOCOL_VERSION } from '@puddle/shared';
import { acquireAuthority } from '../../auth/connection-authority.js';
import { hostPaths } from '../../paths.js';
import type { Transport } from '../../transport/transport.js';
import { CliError } from '../../types.js';
import { startInstalledDaemon } from './start.js';
import {
  inspectHostRemoval as inspect,
  removalFailure as failure,
  selectedHostCapabilities,
  selectedHostHelper as helper,
} from './helper.js';

/** Passive feature detection precedes any invocation of a new host-helper flag. */
async function supportsRestoration(transport: Transport): Promise<boolean> {
  const capabilities = await selectedHostCapabilities(transport);
  if (
    capabilities?.application.major === PROTOCOL_VERSION.major &&
    capabilities.application.minor >= 18
  )
    return true;
  // An older/missing helper cannot turn recorded removal into an ordinary installed host.
  const active = `${hostPaths.home}/installation/removal/services.json`;
  const probe = await transport.exec(
    `if [ -e ${active} ] || [ -L ${active} ]; then exit 0; else exit 3; fi`,
    { timeoutMs: 15_000 },
  );
  if (probe.code !== 3) throw failure();
  return false;
}

/** Explicit install resumes configuration restoration only; startup uses existing readiness. */
export async function restoreInstalledDaemon(transport: Transport): Promise<boolean> {
  if (!(await supportsRestoration(transport))) return false;
  const status = await inspect(transport);
  if (status.state === 'none') return false;
  if (status.state === 'removing') throw failure();
  if (status.state !== 'restored') {
    try {
      // The schema restricts id to a UUID before interpolation. A consumed attempt
      // is continued explicitly and can only observe its already-started steps.
      await transport.exec(
        `${helper} --restore-services ${status.id}${status.state === 'restoring' ? ' --resume' : ''}`,
        { timeoutMs: 120_000 },
      );
    } catch {
      // Lost reply: inspect the exact hand-off, never repeat configuration dispatch.
    }
    const observed = await inspect(transport);
    if (observed.state !== 'restored' || observed.id !== status.id) throw failure();
  }
  // A previous install may have completed startup before losing its reply.
  try {
    const authority = await acquireAuthority(transport);
    authority.close();
    return true;
  } catch (error) {
    if (error instanceof CliError && error.code === 'protocol_mismatch') throw error;
  }
  const endpoint = await startInstalledDaemon(transport);
  endpoint.authority.close();
  return true;
}
