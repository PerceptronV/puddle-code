import { type HostUpdateOperation, type HostUpdateTargets } from '@puddle/shared';
import {
  prepareHostUpdateOperation,
  HostUpdatePreparationError,
  type HostControlClient,
} from '@puddle/shared/node/host-control';
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
  const { onProgress, ...bootstrap } = options;
  const generation = authority.generation;
  try {
    return await prepareHostUpdateOperation(input, {
      authorised: () =>
        generation !== null && authority.generation === generation && authority.state === 'ready',
      execute: (command) => authority.hostUpdate(command),
      stage: (target) =>
        stage(transport, target.component, { ...bootstrap, version: target.version }),
      onProgress,
    });
  } catch (error) {
    if (error instanceof HostUpdatePreparationError) throw new CliError(error.code, error.message);
    throw error;
  }
}
