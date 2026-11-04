import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  PROTOCOL_VERSION,
  hostUpdateCommandSchema,
  type HostUpdateCommand,
  type HostUpdateReply,
} from '@puddle/shared';
import {
  inspectRecordedRecovery,
  readHostUpdateLedger,
  readStageCapabilities,
  updateWorkerExecutables,
} from '@puddle/shared/node/host-control';

/** Trusted host OS/SSH entry, never callable by a browser or an ordinary relay lease. */
export async function continueStoredHostUpdate(
  home: string,
  input: HostUpdateCommand,
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
  try {
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
      (candidate.application.major === 25 && candidate.application.minor < 12)
    )
      return { ok: false, code: 'unsupported', operation: current.operation };
    const paths = updateWorkerExecutables(
      home,
      join(home, 'bin/versions', stage.record.generation),
    );
    try {
      await promisify(execFile)(
        paths.node_path,
        [
          paths.entry_path,
          '--home',
          home,
          '--operation',
          command.reference.id,
          '--dispatch-recovery',
          String(command.reference.revision),
        ],
        { encoding: 'utf8', maxBuffer: 256 * 1024, timeout: 120_000 },
      );
    } catch {
      // The worker can have persisted acceptance before its process or reply was lost.
      // Diagnostics may include host configuration; return only bounded recorded status.
    }
    const observed = inspect();
    return observed.recovery?.requested_revision === command.reference.revision
      ? { ok: true, ...observed }
      : { ok: false, code: 'failed', operation: observed.operation };
  } catch {
    return { ok: false, code: 'failed', operation: null };
  }
}
