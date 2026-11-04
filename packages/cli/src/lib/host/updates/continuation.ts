import { execFile } from 'node:child_process';
import { join } from 'node:path';
import {
  PROTOCOL_VERSION,
  hostUpdateCommandSchema,
  hostUpdateTerminal,
  type HostUpdateOperation,
  type HostStageReceipt,
  type HostUpdateCommand,
  type HostUpdateReply,
} from '@puddle/shared';
import {
  inspectRecordedRecovery,
  readHostUpdateLedger,
  readStageCapabilities,
  updateWorkerExecutables,
} from '@puddle/shared/node/host-control';

export function supportsParticipatingRecovery(protocol: HostStageReceipt['record']['protocol']) {
  return protocol.major === PROTOCOL_VERSION.major && (protocol.major > 25 || protocol.minor >= 17);
}

/** An offer only; the helper revalidates passive metadata and the worker checks fresh host state. */
export function offersOfflineContinuation(operation: HostUpdateOperation | null) {
  return (
    !!operation?.dispatch_id &&
    !hostUpdateTerminal(operation.phase) &&
    operation.stages.some(
      ({ record }) =>
        record.component === 'daemon' && supportsParticipatingRecovery(record.protocol),
    )
  );
}

/** Trusted host OS/SSH entry. Cockpit callers must retain participation until acceptance. */
export async function continueStoredHostUpdate(
  home: string,
  input: HostUpdateCommand,
  participation?: { signal: AbortSignal; authorised: () => boolean },
): Promise<HostUpdateReply> {
  const command = hostUpdateCommandSchema.parse(input);
  if (command.action !== 'recover' || command.strategy !== 'continue')
    return { ok: false, code: 'unsupported', operation: null };
  const inspect = () => {
    const operation = readHostUpdateLedger(home).current;
    if (!operation || operation.id !== command.reference.id)
      throw new Error('Not the current host update');
    return { operation, recovery: inspectRecordedRecovery(home, operation) };
  };
  const requireAuthority = () => {
    if (participation && (participation.signal.aborted || !participation.authorised()))
      throw new Error('Host recovery authority expired');
  };
  try {
    requireAuthority();
    const current = inspect();
    if (
      current.operation.phase === 'complete' ||
      current.recovery?.requested_revision === command.reference.revision
    )
      return { ok: true, ...current };
    if (current.operation.revision !== command.reference.revision)
      return { ok: false, code: 'conflict', operation: current.operation };
    const stage = current.operation.stages.find(({ record }) => record.component === 'daemon');
    if (!stage) return { ok: false, code: 'unsupported', operation: current.operation };
    const candidate = await readStageCapabilities(home, stage);
    if (
      candidate.application.major !== PROTOCOL_VERSION.major ||
      (candidate.application.major === 25 && candidate.application.minor < 12) ||
      (participation && !supportsParticipatingRecovery(candidate.application))
    )
      return { ok: false, code: 'unsupported', operation: current.operation };
    const paths = updateWorkerExecutables(
      home,
      join(home, 'bin/versions', stage.record.generation),
    );
    requireAuthority();
    await new Promise<void>((resolve) => {
      const revoke = () => child.stdin?.end();
      const child = execFile(
        paths.node_path,
        [
          paths.entry_path,
          '--home',
          home,
          '--operation',
          command.reference.id,
          participation ? '--participating-recovery' : '--dispatch-recovery',
          String(command.reference.revision),
        ],
        { encoding: 'utf8', maxBuffer: 256 * 1024, timeout: 120_000 },
        () => {
          participation?.signal.removeEventListener('abort', revoke);
          resolve();
        },
      );
      child.stdin?.on('error', () => {});
      participation?.signal.addEventListener('abort', revoke, { once: true });
      if (participation?.signal.aborted) revoke();
      // Keep controlled stdin open. Closing it revokes pre-commit authority, without
      // killing a dispatcher that already accepted an independent recovery worker.
    });
    // A failed/lost worker reply can follow durable acceptance. Never return its
    // diagnostics or replay; inspect the exact revision's recorded acceptance.
    const observed = inspect();
    return observed.recovery?.requested_revision === command.reference.revision
      ? { ok: true, ...observed }
      : { ok: false, code: 'failed', operation: observed.operation };
  } catch {
    return { ok: false, code: 'failed', operation: null };
  }
}
