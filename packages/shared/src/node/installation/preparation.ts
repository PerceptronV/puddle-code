import {
  hostUpdateTargetsSchema,
  type HostUpdateTargets,
  type HostUpdateOperation,
} from '../../installation/update.js';
import type { HostUpdateCommand, HostUpdateReply } from '../../api/connection/host-updates.js';
import type { HostStageReceipt } from '../../installation/stage.js';

export class HostUpdatePreparationError extends Error {
  constructor(
    readonly code: 'daemon_unreachable' | 'not_installed',
    message: string,
  ) {
    super(message);
  }
}

/** One begin winner stages; uncertain writes are observed, never resubmitted. */
export async function prepareHostUpdateOperation(
  input: HostUpdateTargets,
  deps: {
    authorised(): boolean;
    execute(command: HostUpdateCommand): Promise<HostUpdateReply>;
    stage(target: HostUpdateTargets[number]): Promise<HostStageReceipt>;
    onProgress?(operation: HostUpdateOperation): void;
  },
): Promise<HostUpdateOperation> {
  const targets = hostUpdateTargetsSchema.parse(input);
  const requireAuthority = () => {
    if (!deps.authorised())
      throw new HostUpdatePreparationError(
        'daemon_unreachable',
        'Host update connection changed; inspect the operation before continuing',
      );
  };
  requireAuthority();
  const begun = await deps.execute({ action: 'begin', targets });
  if (!begun.ok || !begun.operation)
    throw new HostUpdatePreparationError(
      'not_installed',
      'Could not begin the host update; inspect its current status',
    );
  let operation = begun.operation;
  deps.onProgress?.(operation);
  if (!begun.created) return operation;
  for (const target of operation.targets) {
    requireAuthority();
    let receipt: HostStageReceipt;
    try {
      receipt = await deps.stage(target);
    } catch (error) {
      if (deps.authorised()) {
        await deps
          .execute({
            action: 'cancel',
            reference: { id: operation.id, revision: operation.revision },
            reason: 'staging_failed',
          })
          .catch(() => {});
      }
      throw error;
    }
    requireAuthority();
    const recorded = await deps.execute({
      action: 'stage',
      reference: { id: operation.id, revision: operation.revision },
      receipt,
    });
    if (!recorded.ok || !recorded.operation)
      throw new HostUpdatePreparationError(
        'not_installed',
        'The host did not accept the exact stage; inspect the operation before continuing',
      );
    operation = recorded.operation;
    deps.onProgress?.(operation);
  }
  return operation;
}
