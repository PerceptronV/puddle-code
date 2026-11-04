import {
  hostReleaseCapabilitiesSchema,
  hostRemovalStatusSchema,
  PROTOCOL_VERSION,
  type HostRemovalStatus,
} from '@puddle/shared';
import { acquireAuthority } from '../../auth/connection-authority.js';
import { hostPaths } from '../../paths.js';
import type { Transport } from '../../transport/transport.js';
import { CliError } from '../../types.js';
import { startInstalledDaemon } from './start.js';

const helper = `${hostPaths.current}/bin/node ${hostPaths.current}/daemon/host-update.mjs --home ${hostPaths.home}`;
const failure = () =>
  new CliError(
    'upgrade_failed',
    'The recorded host removal could not be restored',
    'Resolve the recorded removal before installing; no service action was automatically retried',
  );

async function inspect(transport: Transport): Promise<HostRemovalStatus> {
  const result = await transport.exec(`${helper} --inspect-removal`, { timeoutMs: 15_000 });
  if (result.code !== 0 || Buffer.byteLength(result.stdout) > 4096) throw failure();
  try {
    return hostRemovalStatusSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw failure();
  }
}

/** Passive feature detection precedes any invocation of a new host-helper flag. */
async function supportsRestoration(transport: Transport): Promise<boolean> {
  const path = `${hostPaths.current}/HOST_CAPABILITIES.json`;
  const result = await transport.exec(
    `if [ -f ${path} ] && [ ! -L ${path} ]; then head -c 32769 ${path}; ` +
      `elif [ -e ${path} ] || [ -L ${path} ]; then exit 1; else exit 3; fi`,
    { timeoutMs: 15_000 },
  );
  if (result.code !== 0 && result.code !== 3) throw failure();
  if (result.code === 0) {
    try {
      if (Buffer.byteLength(result.stdout) > 32768) throw failure();
      const { application } = hostReleaseCapabilitiesSchema.parse(JSON.parse(result.stdout));
      if (application.major === PROTOCOL_VERSION.major && application.minor >= 18) return true;
    } catch {
      throw failure();
    }
  }
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
