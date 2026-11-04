import {
  PROTOCOL_VERSION,
  hostRemovalFinishSchema,
  hostRemovalRuntimeReviewSchema,
  type HostRemovalFinish,
  type HostRemovalRuntimeReview,
} from '@puddle/shared';
import { randomUUID } from 'node:crypto';
import type { Transport } from '../../transport/transport.js';
import { CliError } from '../../types.js';
import {
  inspectHostRemoval,
  removalFailure,
  selectedHostCapabilities,
  selectedHostHelper,
} from './helper.js';

export async function requireHostRemovalSupport(transport: Transport): Promise<void> {
  const capabilities = await selectedHostCapabilities(transport);
  if (
    !capabilities ||
    capabilities.application.major !== PROTOCOL_VERSION.major ||
    capabilities.application.minor < 19
  )
    throw new CliError(
      'upgrade_failed',
      'This host does not support coordinated runtime-preserving removal',
      'Upgrade the daemon before removing it; persistent installations cannot use legacy deletion',
    );
}

/** Call only after explicit consent to stop daemon-owned work and disable remote access. */
export async function prepareHostRemoval(transport: Transport): Promise<HostRemovalRuntimeReview> {
  await requireHostRemovalSupport(transport);
  const state = await inspectHostRemoval(transport);
  if (state.state === 'restoring') throw removalFailure();
  const id = state.state === 'removed' || state.state === 'removing' ? state.id : null;
  const result = await transport.exec(
    `${selectedHostHelper} --prepare-removal${id ? ` ${id}` : ''}`,
    { timeoutMs: 120_000 },
  );
  if (result.code !== 0 || Buffer.byteLength(result.stdout) > 512 * 1024) throw removalFailure();
  try {
    const review = hostRemovalRuntimeReviewSchema.parse(JSON.parse(result.stdout));
    if (id && id !== review.id) throw removalFailure();
    return review;
  } catch {
    throw removalFailure();
  }
}

export async function finishHostRemoval(
  transport: Transport,
  input: Omit<HostRemovalFinish, 'attempt_id'>,
): Promise<void> {
  await requireHostRemovalSupport(transport);
  const request = hostRemovalFinishSchema.parse({ ...input, attempt_id: randomUUID() });
  try {
    // Schema-validated UUID, hex digest and enum are literal shell arguments.
    await transport.exec(
      `${selectedHostHelper} --finish-removal ${request.id} ${request.fingerprint} ${request.attempt_id} ${request.disposition}`,
      { timeoutMs: 120_000 },
    );
  } catch {
    /* A lost reply is followed only by exact receipt inspection. */
  }
  const result = await transport.exec(`${selectedHostHelper} --inspect-removal-result`, {
    timeoutMs: 15_000,
  });
  if (result.code !== 0 || Buffer.byteLength(result.stdout) > 4096) throw removalFailure();
  try {
    const receipt = hostRemovalFinishSchema.parse(JSON.parse(result.stdout));
    if (JSON.stringify(receipt) !== JSON.stringify(request)) throw removalFailure();
  } catch {
    throw removalFailure();
  }
  const observed = await inspectHostRemoval(transport);
  if (observed.state !== 'removed' || observed.id !== request.id) throw removalFailure();
}
