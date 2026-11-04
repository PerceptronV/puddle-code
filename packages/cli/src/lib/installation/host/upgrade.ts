import type { HostUpdateOperation } from '@puddle/shared';
import { acquireAuthority } from '../../auth/connection-authority.js';
import type { Transport } from '../../transport/transport.js';
import { silentLogger } from '../../types.js';
import { installedVersion, type BootstrapOptions, type HostComponent } from '../bootstrap.js';
import { applyHostUpdate, hostUpdateFailure, type ConfirmHostUpdateInterruption } from './apply.js';
import { prepareHostUpdate } from './updates.js';

/** Shared local/SSH entry point; the CLI process participates throughout preparation. */
export async function upgradeHostComponent(
  transport: Transport,
  component: HostComponent,
  options: BootstrapOptions & {
    version: string;
    confirmInterruption?: ConfirmHostUpdateInterruption;
  },
): Promise<{ from: string | null; to: string; operation: HostUpdateOperation }> {
  const logger = options.logger ?? silentLogger;
  const from = await installedVersion(transport, component);
  const authority = await acquireAuthority(transport);
  let lastPhase: HostUpdateOperation['phase'] | undefined;
  const onProgress: (operation: HostUpdateOperation) => void = (operation) => {
    if (lastPhase === undefined) logger.info(`host update ${operation.id} on ${transport.label}`);
    if (lastPhase !== operation.phase) logger.info(`${component} update: ${operation.phase}`);
    lastPhase = operation.phase;
  };
  try {
    const generation = authority.generation;
    const operation = await prepareHostUpdate(
      transport,
      authority,
      [{ component, version: options.version }],
      { tarball: options.tarball, logger, onProgress },
    );
    if (authority.generation !== generation || authority.state !== 'ready')
      throw hostUpdateFailure(operation, 'Host update connection changed before approval');
    return {
      from,
      to: options.version,
      operation: await applyHostUpdate(
        authority,
        operation,
        onProgress,
        options.confirmInterruption,
      ),
    };
  } finally {
    authority.close();
  }
}
