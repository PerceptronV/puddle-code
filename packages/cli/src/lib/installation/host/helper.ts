import {
  hostReleaseCapabilitiesSchema,
  hostRemovalStatusSchema,
  type HostReleaseCapabilities,
  type HostRemovalStatus,
} from '@puddle/shared';
import { hostPaths } from '../../paths.js';
import type { Transport } from '../../transport/transport.js';
import { CliError } from '../../types.js';

export const selectedHostHelper = `${hostPaths.current}/bin/node ${hostPaths.current}/daemon/host-update.mjs --home ${hostPaths.home}`;
export const removalFailure = () =>
  new CliError(
    'upgrade_failed',
    'The recorded host removal could not be completed',
    'Inspect the recorded removal before continuing; no uncertain service action was automatically retried',
  );

/** Public passive metadata only; older executables must never receive unknown management flags. */
export async function selectedHostCapabilities(
  transport: Transport,
): Promise<HostReleaseCapabilities | null> {
  const path = `${hostPaths.current}/HOST_CAPABILITIES.json`;
  const result = await transport.exec(
    `if [ -f ${path} ] && [ ! -L ${path} ]; then head -c 32769 ${path}; ` +
      `elif [ -e ${path} ] || [ -L ${path} ]; then exit 1; else exit 3; fi`,
    { timeoutMs: 15_000 },
  );
  if (result.code === 3) return null;
  if (result.code !== 0 || Buffer.byteLength(result.stdout) > 32768) throw removalFailure();
  try {
    return hostReleaseCapabilitiesSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw removalFailure();
  }
}

export async function inspectHostRemoval(transport: Transport): Promise<HostRemovalStatus> {
  const result = await transport.exec(`${selectedHostHelper} --inspect-removal`, {
    timeoutMs: 15_000,
  });
  if (result.code !== 0 || Buffer.byteLength(result.stdout) > 4096) throw removalFailure();
  try {
    return hostRemovalStatusSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw removalFailure();
  }
}
