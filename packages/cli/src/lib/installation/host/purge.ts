import { randomUUID } from 'node:crypto';
import {
  supportsApplicationFeature,
  hostPurgeApplySchema,
  hostPurgeReviewSchema,
  type HostPurgeReview,
} from '@puddle/shared';
import type { Transport } from '../../transport/transport.js';
import { CliError } from '../../types.js';
import { selectedHostCapabilities, selectedHostHelper } from './helper.js';

function failure() {
  return new CliError(
    'upgrade_failed',
    'The recorded host purge could not be completed',
    'Data may be partially retained; inspect the host and rerun the explicit purge command to continue. No legacy deletion was attempted.',
  );
}

export async function requireHostPurgeSupport(transport: Transport): Promise<void> {
  const capabilities = await selectedHostCapabilities(transport);
  if (!supportsApplicationFeature(capabilities?.application, { major: 25, minor: 20 }))
    throw new CliError(
      'upgrade_failed',
      'This host does not support coordinated data purge',
      'Upgrade the daemon before purging; ordinary removal can retain all data.',
    );
}

export async function inspectHostPurge(transport: Transport): Promise<HostPurgeReview | null> {
  const result = await transport.exec(`${selectedHostHelper} --inspect-purge`, {
    timeoutMs: 15_000,
  });
  if (result.code !== 0 || Buffer.byteLength(result.stdout) > 4 * 1024 * 1024) throw failure();
  try {
    return hostPurgeReviewSchema.nullable().parse(JSON.parse(result.stdout));
  } catch {
    throw failure();
  }
}

export async function prepareHostPurge(transport: Transport, id: string): Promise<HostPurgeReview> {
  hostPurgeReviewSchema.shape.id.parse(id);
  let result;
  try {
    result = await transport.exec(`${selectedHostHelper} --prepare-purge ${id}`, {
      timeoutMs: 120_000,
    });
  } catch {
    // A lost mutation reply permits observation only, never a second dispatch.
    const recorded = await inspectHostPurge(transport);
    if (recorded?.id === id) return recorded;
    throw failure();
  }
  if (result.code !== 0 || Buffer.byteLength(result.stdout) > 4 * 1024 * 1024) throw failure();
  try {
    const review = hostPurgeReviewSchema.parse(JSON.parse(result.stdout));
    if (review.id !== id) throw failure();
    return review;
  } catch {
    throw failure();
  }
}

export async function applyHostPurge(
  transport: Transport,
  review: HostPurgeReview,
  timeoutMs = 120_000,
): Promise<{ review: HostPurgeReview; dispatchAcknowledged: boolean }> {
  const request = hostPurgeApplySchema.parse({
    id: review.id,
    fingerprint: review.fingerprint,
    attempt_id: randomUUID(),
  });
  let dispatchAcknowledged = false;
  try {
    const result = await transport.exec(
      `${selectedHostHelper} --apply-purge ${request.id} ${request.fingerprint} ${request.attempt_id}`,
      { timeoutMs },
    );
    dispatchAcknowledged = result.code === 0;
  } catch {
    /* Inspect exact consumption after a lost reply. */
  }
  const recorded = await inspectHostPurge(transport);
  if (
    !recorded ||
    recorded.id !== request.id ||
    recorded.fingerprint !== request.fingerprint ||
    recorded.attempt_id !== request.attempt_id
  )
    throw failure();
  return { review: recorded, dispatchAcknowledged };
}
