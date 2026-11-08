import { readUpdateRecoveryAttempts } from '@puddle/shared/node/host-control';
import type { HostUpdateOperation } from '@puddle/shared';
import { canonicalHuddleJson } from '@puddle/shared';
import { digest } from '@puddle/shared/node';

import { readHostUpdateCheckpointEvidence } from './store.js';

/** Recovery can encounter owners created after the original checkpoint; never drop their proof. */
export function readUpdateAdoptionRequirements(home: string, operation: HostUpdateOperation) {
  const evidence = readHostUpdateCheckpointEvidence(home, operation.id);
  const owners = new Map(
    evidence.checkpoint.owners.map((owner) => [owner.identity.runtime_id, owner]),
  );
  let schema = evidence.checkpoint.daemon.schema_version;
  const restarts = readUpdateRecoveryAttempts(home, operation.id).attempts.filter(
    ({ job }) => job.daemon_restart,
  );
  for (const { job } of restarts) {
    if (
      job.original_dispatch_id !== operation.dispatch_id ||
      job.original_worker_id !== operation.worker_id ||
      job.preflight !== operation.approved ||
      job.revision > operation.revision
    )
      throw new Error('Restart requirements do not match this update');
    const restart = job.daemon_restart!;
    schema = Math.max(schema, restart.database_schema_version);
    for (const owner of restart.owners) {
      const previous = owners.get(owner.identity.runtime_id);
      if (
        previous &&
        (JSON.stringify(previous.identity) !== JSON.stringify(owner.identity) ||
          previous.build !== owner.build ||
          JSON.stringify(previous.protocol) !== JSON.stringify(owner.protocol) ||
          previous.release_path !== owner.release_path ||
          previous.launch_fingerprint !== owner.launch_fingerprint ||
          canonicalHuddleJson(previous.huddle ?? null) !==
            canonicalHuddleJson(owner.huddle ?? null) ||
          previous.event_cursor > owner.event_cursor ||
          (['exited', 'failed'].includes(previous.state) && previous.state !== owner.state))
      )
        throw new Error('Restart requirements changed immutable runtime ownership');
      owners.set(owner.identity.runtime_id, owner);
    }
  }
  return {
    ...evidence,
    owners: [...owners.values()],
    schema,
    digest: restarts.length
      ? digest(
          JSON.stringify({
            checkpoint: evidence.digest,
            restarts: restarts.map(({ job }) => ({ id: job.id, evidence: job.daemon_restart })),
          }),
        )
      : evidence.digest,
  };
}
