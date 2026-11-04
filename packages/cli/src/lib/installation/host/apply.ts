import { setTimeout as delay } from 'node:timers/promises';
import {
  PROTOCOL_VERSION,
  hostUpdateTerminal,
  type HostUpdateOperation,
  type HostUpdateReply,
  type HostUpdateReview,
} from '@puddle/shared';
import type { HostControlClient } from '@puddle/shared/node/host-control';
import { CliError } from '../../types.js';

/** Shell/cockpit-owned UI; absence never grants interruption consent. */
export type ConfirmHostUpdateInterruption = (request: {
  operation: HostUpdateOperation;
  review: HostUpdateReview;
}) => Promise<boolean>;

type Authority = Pick<HostControlClient, 'generation' | 'state' | 'hostUpdate'>;
type Progress = (operation: HostUpdateOperation) => void;
const reference = ({ id, revision }: HostUpdateOperation) => ({ id, revision });

export function hostUpdateFailure(operation: HostUpdateOperation, message: string): CliError {
  return new CliError(
    'upgrade_failed',
    message,
    `Inspect operation ${operation.id} with puddle updates --operation ${operation.id} on the same host`,
  );
}

function accepted(reply: HostUpdateReply, operation: HostUpdateOperation): HostUpdateOperation {
  if (!reply.ok || !reply.operation || reply.operation.id !== operation.id)
    throw hostUpdateFailure(
      operation,
      `Host update response requires inspection${reply.ok ? '' : ` (${reply.code})`}`,
    );
  return reply.operation;
}

/** Read-only observation may follow a replacement lease; it never retries a mutation. */
async function observe(
  authority: Authority,
  initial: HostUpdateOperation,
  ready: (operation: HostUpdateOperation) => boolean,
  onProgress: Progress,
  timeoutMs: number,
): Promise<HostUpdateOperation> {
  const deadline = performance.now() + timeoutMs;
  let operation = initial;
  while (!ready(operation)) {
    if (performance.now() >= deadline)
      throw hostUpdateFailure(operation, 'Host update is still unresolved; no action was repeated');
    await delay(1000);
    if (authority.state === 'protocol_mismatch')
      throw hostUpdateFailure(operation, 'The replacement host protocol is incompatible');
    if (authority.state !== 'ready') continue;
    let reply: HostUpdateReply;
    try {
      reply = await authority.hostUpdate({ action: 'status', id: operation.id });
    } catch {
      continue; // A read can be repeated after the existing authority client reconnects.
    }
    if (!reply.ok && ['rejected', 'unavailable', 'failed'].includes(reply.code)) continue;
    const next = accepted(reply, operation);
    if (next.revision !== operation.revision) onProgress(next);
    operation = next;
  }
  return operation;
}

/** Inspect once, approve the exact impact, then observe without repeating activation. */
export async function applyHostUpdate(
  authority: Authority,
  initial: HostUpdateOperation,
  onProgress: Progress = () => {},
  confirmInterruption?: ConfirmHostUpdateInterruption,
): Promise<HostUpdateOperation> {
  const generation = authority.generation;
  const requireConnection = () => {
    if (!generation || authority.generation !== generation || authority.state !== 'ready')
      throw hostUpdateFailure(initial, 'Host update connection changed before approval');
  };
  requireConnection();
  let operation = await observe(
    authority,
    initial,
    (current) => !['checking', 'downloading'].includes(current.phase),
    onProgress,
    12 * 60_000,
  );
  if (['staged', 'preflight', 'approved'].includes(operation.phase)) {
    requireConnection();
    const review = await authority.hostUpdate({
      action: 'inspect',
      reference: reference(operation),
      cockpit: PROTOCOL_VERSION,
    });
    operation = accepted(review, operation);
    onProgress(operation);
    const inspection = review.ok ? review.review : undefined;
    const interruption = inspection?.interruption_fingerprint;
    const fingerprint = inspection?.fingerprint ?? interruption;
    if (!inspection || !fingerprint || (!inspection.can_apply && !interruption)) {
      const blockers = review.ok ? review.review?.blockers.map((item) => item.code).join(', ') : '';
      throw hostUpdateFailure(
        operation,
        `Host update checks did not pass${blockers ? `: ${blockers}` : ''}`,
      );
    }
    requireConnection();
    if (interruption) {
      if (!(await confirmInterruption?.({ operation, review: inspection })))
        throw hostUpdateFailure(operation, 'Host update interruption was not approved');
      requireConnection();
    }
    let applied: HostUpdateReply | undefined;
    try {
      applied = await authority.hostUpdate({
        action: 'apply',
        reference: reference(operation),
        cockpit: PROTOCOL_VERSION,
        fingerprint,
        ...(interruption ? { interruption_approval: interruption } : {}),
      });
    } catch {
      // The host may have consumed dispatch. Observe this id, even if still in preflight.
    }
    if (
      applied &&
      (applied.ok ||
        applied.operation ||
        applied.code === 'conflict' ||
        applied.code === 'unsupported')
    ) {
      if (applied.operation?.id === operation.id && applied.operation.dispatch_id) {
        operation = applied.operation;
      } else {
        operation = accepted(applied, operation);
      }
      onProgress(operation);
    }
  }
  operation = await observe(
    authority,
    operation,
    (current) => hostUpdateTerminal(current.phase) || current.phase === 'recovery_required',
    onProgress,
    3 * 60_000,
  );
  if (operation.phase !== 'complete')
    throw hostUpdateFailure(operation, operation.message ?? `Host update ${operation.phase}`);
  return operation;
}
