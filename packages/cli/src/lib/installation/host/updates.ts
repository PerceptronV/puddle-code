import {
  hostUpdateTargetsSchema,
  type HostUpdateOperation,
  type HostUpdateTargets,
} from '@puddle/shared';
import type { HostControlClient } from '@puddle/shared/node/host-control';
import type { Transport } from '../../transport/transport.js';
import { CliError } from '../../types.js';
import type { BootstrapOptions } from '../bootstrap.js';
import { stageHostComponent } from './staging.js';

type Authority = Pick<HostControlClient, 'generation' | 'state' | 'hostUpdate'>;

/** The winning caller stages through the existing transport; other windows observe its operation. */
export async function prepareHostUpdate(
  transport: Transport,
  authority: Authority,
  input: HostUpdateTargets,
  options: Omit<BootstrapOptions, 'version'> & {
    onProgress?: (operation: HostUpdateOperation) => void;
  } = {},
  stage = stageHostComponent,
): Promise<HostUpdateOperation> {
  const targets = hostUpdateTargetsSchema.parse(input);
  const { onProgress, ...bootstrap } = options;
  const generation = authority.generation;
  const current = () =>
    generation !== null && authority.generation === generation && authority.state === 'ready';
  if (!current()) throw new CliError('daemon_unreachable', 'Host update authority is unavailable');
  const begun = await authority.hostUpdate({ action: 'begin', targets });
  if (!begun.ok || !begun.operation)
    throw new CliError(
      'not_installed',
      'Could not begin the host update; inspect its current status',
    );
  let operation = begun.operation;
  onProgress?.(operation);
  if (!begun.created) return operation;
  for (const target of operation.targets) {
    if (!current())
      throw new CliError(
        'daemon_unreachable',
        'Host update connection changed; inspect the operation before continuing',
      );
    let receipt;
    try {
      receipt = await stage(transport, target.component, { ...bootstrap, version: target.version });
    } catch (error) {
      if (current()) {
        // A failed preparation can leave an unselected stage, never a live activation.
        await authority
          .hostUpdate({
            action: 'cancel',
            reference: { id: operation.id, revision: operation.revision },
            reason: 'staging_failed',
          })
          .catch(() => {});
      }
      throw error;
    }
    if (!current())
      throw new CliError(
        'daemon_unreachable',
        'Host update connection changed; inspect the operation before continuing',
      );
    const recorded = await authority.hostUpdate({
      action: 'stage',
      reference: { id: operation.id, revision: operation.revision },
      receipt,
    });
    if (!recorded.ok || !recorded.operation)
      throw new CliError(
        'not_installed',
        'The host did not accept the exact stage; inspect the operation before continuing',
      );
    operation = recorded.operation;
    onProgress?.(operation);
  }
  return operation;
}
