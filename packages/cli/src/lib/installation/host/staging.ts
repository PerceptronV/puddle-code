import { hostStageReceiptSchema, type HostStageReceipt } from '@puddle/shared';
import { createHash } from 'node:crypto';
import {
  bootstrapHostComponent,
  runHostInstaller,
  type BootstrapOptions,
  type HostComponent,
} from '../bootstrap.js';
import type { Transport } from '../../transport/transport.js';
import { CliError, type Logger } from '../../types.js';
import { pinnedDaemonVersion } from '../../version.js';

function validatedReceipt(value: unknown): HostStageReceipt {
  const receipt = hostStageReceiptSchema.parse(value);
  const digest = createHash('sha256')
    .update(`${JSON.stringify(receipt.record)}\n`)
    .digest('hex');
  if (digest !== receipt.digest)
    throw new CliError('not_installed', 'The host stage receipt digest does not match its record');
  return receipt;
}

/** Stage a concrete release without changing selectors, wrappers or services. */
export async function stageHostComponent(
  transport: Transport,
  component: HostComponent,
  options: BootstrapOptions = {},
): Promise<HostStageReceipt> {
  const output = await bootstrapHostComponent(transport, component, options, 'stage');
  const prefix = 'PUDDLE_HOST_STAGE ';
  const lines = output.split('\n').filter((line) => line.startsWith(prefix));
  if (lines.length !== 1 || lines[0]!.length > 4096)
    throw new CliError(
      'not_installed',
      'The host installer did not return one bounded stage receipt',
    );
  const receipt = validatedReceipt(JSON.parse(lines[0]!.slice(prefix.length)));
  if (
    receipt.record.component !== component ||
    receipt.record.version !== (options.version ?? pinnedDaemonVersion())
  )
    throw new CliError('not_installed', 'The host staged a different component or release');
  return receipt;
}

/** Host-authorised activation primitive; the update coordinator supplies preflight. */
export async function activateHostStage(
  transport: Transport,
  receipt: HostStageReceipt,
  options: { logger?: Logger; noSupervisor?: boolean } = {},
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
    ],
    options.logger,
  );
}
