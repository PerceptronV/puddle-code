import { hostPaths } from '../../paths.js';
import { CliError } from '../../types.js';
import type { Transport } from '../../transport/transport.js';

/** Positive evidence forbids legacy bootstrap, even when a selector is damaged. */
export async function hasPersistentHostInstallation(transport: Transport): Promise<boolean> {
  const markers = [
    `${hostPaths.current}/HOST_CAPABILITIES.json`,
    `${hostPaths.home}/bin/runtime-current`,
    `${hostPaths.home}/updates/operations.json`,
    `${hostPaths.home}/runtime-controller.json`,
    `${hostPaths.home}/runtimes`,
  ];
  const result = await transport.exec(
    `if ${markers.map((path) => `[ -e ${path} ] || [ -L ${path} ]`).join(' || ')}; then exit 0; else exit 3; fi`,
    { timeoutMs: 15_000 },
  );
  if (result.code === 0) return true;
  if (result.code === 3) return false;
  throw new CliError('daemon_unreachable', 'The host installation could not be inspected');
}
