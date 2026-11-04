import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  HOST_UPDATE_CHECKPOINT_BYTES,
  HOST_UPDATE_RECOVERY_BYTES,
  hostUpdateCheckpointSchema,
  hostUpdateWorkerSchema,
  hostUpdateWorkerLifetimeSchema,
  hostUpdateTerminal,
  type HostUpdateOperation,
} from '@puddle/shared';
import {
  atomicPrivateJson,
  digest,
  privateDirectory,
  syncPrivateDirectory,
} from '@puddle/shared/node';
import { readUpdateRecoveryAttempts } from '@puddle/shared/node/host-control';
import { acquireHostClaim } from '../../../../security/claims.js';
import type { CompilationCommandRunner } from '../../../../compilation/process.js';
import { requireEndedUpdateWorker } from '../../../../updates/worker/lifetime.js';
import { requireEndedUpdateRecoveryWorkers } from '../../../../updates/recovery/worker/records.js';
import { retainTerminalUpdate } from '../../../../updates/operations/retained.js';
import { HostActionWriter } from '../../action-writer.js';
import { serviceIsRemoved } from '../../../supervision/removed.js';
import { optionalRecord } from '../inventory.js';
import type { CollectionBudget } from '../budget.js';
import { updateRetirementService, unregisterUpdateService } from './services.js';

const journalSchema = z
  .object({
    format: z.literal(1),
    home: z.string(),
    operation: z.uuid(),
    evidence: z.string().regex(/^[a-f0-9]{64}$/),
    actions: z
      .array(
        z
          .object({
            action: z.string().min(1).max(256),
            state: z.enum(['planned', 'started', 'finished']),
          })
          .strict(),
      )
      .max(33),
  })
  .strict();
const file = (home: string, id: string) =>
  join(home, 'installation/collection/updates', `${id}.json`);

export function updateReleaseEvidence(
  home: string,
  operation: HostUpdateOperation,
  budget: CollectionBudget,
) {
  if (!hostUpdateTerminal(operation.phase))
    throw new Error('An active update cannot retire references');
  const directory = join(home, 'updates/jobs', operation.id);
  const raw = optionalRecord(join(directory, 'worker.json'), 32 * 1024, budget);
  const worker = raw ? hostUpdateWorkerSchema.parse(raw) : null;
  const lifetime = optionalRecord(join(directory, 'lifetime.json'), 4096, budget);
  const checkpoint = optionalRecord(
    join(home, 'updates/checkpoints', `${operation.id}.json`),
    HOST_UPDATE_CHECKPOINT_BYTES,
    budget,
  );
  if (checkpoint) {
    const parsed = hostUpdateCheckpointSchema.parse(checkpoint);
    if (
      parsed.operation_id !== operation.id ||
      parsed.dispatch_id !== operation.dispatch_id ||
      parsed.preflight !== operation.approved
    )
      throw new Error('Update checkpoint identity changed');
  }
  budget.record(join(directory, 'recovery/attempts.json'));
  const attempts = readUpdateRecoveryAttempts(home, operation.id);
  const recoveryRaw = optionalRecord(
    join(directory, 'recovery/attempts.json'),
    HOST_UPDATE_RECOVERY_BYTES,
    budget,
  );
  if (
    worker &&
    (worker.operation_id !== operation.id ||
      worker.dispatch_id !== operation.dispatch_id ||
      worker.preflight !== operation.approved)
  )
    throw new Error('Update worker identity changed');
  if (operation.worker_id) {
    if (!worker || !lifetime) throw new Error('Missing consumed update lifetime');
    const life = hostUpdateWorkerLifetimeSchema.parse(lifetime);
    if (
      life.worker_id !== operation.worker_id ||
      life.operation_id !== operation.id ||
      life.dispatch_id !== operation.dispatch_id ||
      life.preflight !== operation.approved
    )
      throw new Error('Consumed update lifetime changed');
  } else if (worker || lifetime || attempts.attempts.length || checkpoint)
    throw new Error('Unexpected unconsumed update evidence');
  const services = worker
    ? [
        updateRetirementService(home, operation.id, worker),
        ...attempts.attempts.map(({ job }) =>
          updateRetirementService(home, operation.id, job.service, job.id),
        ),
      ]
    : [];
  return {
    worker,
    services,
    digest: digest(
      JSON.stringify({ operation, worker: raw, lifetime, checkpoint, recovery: recoveryRaw }),
    ),
  };
}

export function updateReleaseRetired(
  home: string,
  operation: HostUpdateOperation,
  budget: CollectionBudget,
): boolean {
  const raw = optionalRecord(file(home, operation.id), 32 * 1024, budget);
  if (!raw) return false;
  const journal = journalSchema.parse(raw);
  const evidence = updateReleaseEvidence(home, operation, budget);
  return (
    journal.home === realpathSync(home) &&
    journal.operation === operation.id &&
    journal.evidence === evidence.digest &&
    JSON.stringify(journal.actions.map(({ action }) => action)) ===
      JSON.stringify(evidence.services.map(({ service }) => service.name)) &&
    journal.actions.every(({ state }) => state === 'finished')
  );
}

/** Claims fence delayed original/recovery dispatch; exact terminal records survive ledger eviction. */
export async function retireUpdateRelease(
  home: string,
  operation: HostUpdateOperation,
  requireCurrent: () => void,
  run: CompilationCommandRunner,
  budget: CollectionBudget,
  write = atomicPrivateJson,
): Promise<void> {
  const dispatch = acquireHostClaim(home, `host-update-dispatch:${operation.id}`);
  try {
    requireCurrent();
    const evidence = updateReleaseEvidence(home, operation, budget);
    if (updateReleaseRetired(home, operation, budget)) return;
    const check = () => {
      requireCurrent();
      if (updateReleaseEvidence(home, operation, budget).digest !== evidence.digest)
        throw new Error('Update release retirement evidence changed');
      if (evidence.worker) {
        requireEndedUpdateWorker(home, evidence.worker, operation);
        requireEndedUpdateRecoveryWorkers(home, operation);
      }
    };
    check();
    retainTerminalUpdate(home, operation, write);
    const initial = journalSchema.parse({
      format: 1,
      home: realpathSync(home),
      operation: operation.id,
      evidence: evidence.digest,
      actions: evidence.services.map(({ service }) => ({ action: service.name, state: 'planned' })),
    });
    privateDirectory(join(home, 'installation'));
    privateDirectory(join(home, 'installation/collection'));
    privateDirectory(join(home, 'installation/collection/updates'));
    syncPrivateDirectory(join(home, 'installation/collection'));
    const path = file(home, operation.id);
    const previous = optionalRecord(path, 32 * 1024, budget);
    const writer = new HostActionWriter({
      path,
      initial,
      parse: journalSchema.parse,
      maxBytes: 32 * 1024,
      requireCurrent: check,
      write,
      resume: previous !== null,
    });
    for (const target of evidence.services) {
      const action = writer.read().actions.find(({ action }) => action === target.service.name)!;
      if (action.state === 'finished') continue;
      const verify = async () => {
        check();
        if (!(await serviceIsRemoved(home, target.service, run)))
          throw new Error('Update service retirement remains uncertain');
        check();
      };
      if (action.state === 'started') await writer.observe(action.action, verify);
      else
        await writer.run(action.action, async () => {
          await unregisterUpdateService(home, target, check, run);
          await verify();
        });
    }
  } finally {
    dispatch.release();
  }
}
