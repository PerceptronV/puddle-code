import type { HostStageReceipt } from '@puddle/shared';
import { validateHostStageReceipt, parseHostStageOutput } from '@puddle/shared/node/host-control';
import {
  bootstrapHostComponent,
  runHostInstaller,
  type BootstrapOptions,
  type HostComponent,
} from '../bootstrap.js';
import type { Transport } from '../../transport/transport.js';
import { CliError, type Logger } from '../../types.js';
import { pinnedHostVersion } from '../../version.js';

function validatedReceipt(value: unknown): HostStageReceipt {
  try {
    return validateHostStageReceipt(value);
  } catch (error) {
    throw new CliError(
      'not_installed',
      error instanceof Error ? error.message : 'Invalid host stage receipt',
    );
  }
}

/** Stage a concrete release without changing selectors, wrappers or services. */
export async function stageHostComponent(
  transport: Transport,
  component: HostComponent,
  options: BootstrapOptions = {},
): Promise<HostStageReceipt> {
  const output = await bootstrapHostComponent(transport, component, options, 'stage');
  try {
    return parseHostStageOutput(output, component, options.version ?? pinnedHostVersion(component));
  } catch (error) {
    throw new CliError(
      'not_installed',
      error instanceof Error ? error.message : 'Invalid host stage receipt',
    );
  }
}

/** Host-authorised activation primitive; the update coordinator supplies preflight. */
export async function activateHostStage(
  transport: Transport,
  receipt: HostStageReceipt,
  options: { logger?: Logger; noSupervisor?: boolean; selectOnly?: boolean } = {},
): Promise<void> {
  const { record, digest } = validatedReceipt(receipt);
  await runHostInstaller(
    transport,
    [
      '--version',
      record.version,
      '--component',
      record.component,
      '--activate-generation',
      record.generation,
      '--stage-digest',
      digest,
      ...(options.noSupervisor ? ['--no-supervisor'] : []),
      ...(options.selectOnly ? ['--select-only'] : []),
    ],
    options.logger,
  );
}
