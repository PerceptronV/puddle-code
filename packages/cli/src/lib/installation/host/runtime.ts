import { setTimeout as delay } from 'node:timers/promises';
import {
  PROTOCOL_VERSION,
  hostUpdateTerminal,
  type HostUpdateOperation,
  type HostUpdateReply,
} from '@puddle/shared';
import type { HostControlClient } from '@puddle/shared/node/host-control';
import { acquireAuthority } from '../../auth/connection-authority.js';
import type { Transport } from '../../transport/transport.js';
import { CliError, silentLogger } from '../../types.js';
import { installedVersion, type BootstrapOptions } from '../bootstrap.js';
import { prepareHostUpdate } from './updates.js';

type Authority = Pick<HostControlClient, 'generation' | 'state' | 'hostUpdate'>;
type Progress = (operation: HostUpdateOperation) => void;
const reference = ({ id, revision }: HostUpdateOperation) => ({ id, revision });

function failure(operation: HostUpdateOperation, message: string): CliError {
  return new CliError(
    'upgrade_failed',
    message,
    `Inspect operation ${operation.id} with puddle updates --operation ${operation.id} on the same host`,
  );
}

function accepted(reply: HostUpdateReply, operation: HostUpdateOperation): HostUpdateOperation {
  if (!reply.ok || !reply.operation || reply.operation.id !== operation.id)
    throw failure(
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
      throw failure(operation, 'Host update is still unresolved; no action was repeated');
    await delay(1000);
    if (authority.state === 'protocol_mismatch')
      throw failure(operation, 'The replacement host protocol is incompatible');
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

/** An explicit runtime update approves only a newly inspected, non-interrupting selection. */
export async function applyRuntimeUpdate(
  authority: Authority,
  initial: HostUpdateOperation,
  onProgress: Progress = () => {},
): Promise<HostUpdateOperation> {
  if (initial.targets.length !== 1 || initial.targets[0]?.component !== 'runtime')
    throw failure(initial, 'This action requires a runtime-only update');
  const generation = authority.generation;
  const requireConnection = () => {
    if (!generation || authority.generation !== generation || authority.state !== 'ready')
      throw failure(initial, 'Host update connection changed before approval');
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
    if (!review.ok || !review.review?.can_apply || !review.review.fingerprint) {
      const blockers = review.ok ? review.review?.blockers.map((item) => item.code).join(', ') : '';
      throw failure(operation, `Host update checks did not pass${blockers ? `: ${blockers}` : ''}`);
    }
    requireConnection();
    let applied: HostUpdateReply | undefined;
    try {
      applied = await authority.hostUpdate({
        action: 'apply',
        reference: reference(operation),
        cockpit: PROTOCOL_VERSION,
        fingerprint: review.review.fingerprint,
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
    throw failure(operation, operation.message ?? `Host update ${operation.phase}`);
  return operation;
}

/** Shared local/SSH entry point; the CLI process participates throughout preparation. */
export async function upgradeRuntime(
  transport: Transport,
  options: BootstrapOptions & { version: string },
): Promise<{ from: string | null; to: string; operation: HostUpdateOperation }> {
  const logger = options.logger ?? silentLogger;
  const from = await installedVersion(transport, 'runtime');
  const authority = await acquireAuthority(transport);
  let lastPhase: HostUpdateOperation['phase'] | undefined;
  const onProgress: Progress = (operation) => {
    if (lastPhase === undefined) logger.info(`host update ${operation.id} on ${transport.label}`);
    if (lastPhase !== operation.phase) logger.info(`runtime update: ${operation.phase}`);
    lastPhase = operation.phase;
  };
  try {
    const generation = authority.generation;
    const operation = await prepareHostUpdate(
      transport,
      authority,
      [{ component: 'runtime', version: options.version }],
      { tarball: options.tarball, logger, onProgress },
    );
    if (authority.generation !== generation || authority.state !== 'ready')
      throw failure(operation, 'Host update connection changed before approval');
    return {
      from,
      to: options.version,
      operation: await applyRuntimeUpdate(authority, operation, onProgress),
    };
  } finally {
    authority.close();
  }
}
