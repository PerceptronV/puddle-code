import { z } from 'zod';
import { hostStageReceiptSchema, hostStageRecordSchema } from './stage.js';

const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.number().int().nonnegative().safe();
export const hostUpdateTargetsSchema = z
  .array(
    z
      .object({
        component: hostStageRecordSchema.shape.component,
        version: hostStageRecordSchema.shape.version,
      })
      .strict(),
  )
  .min(1)
  .max(2)
  .refine((targets) => new Set(targets.map((target) => target.component)).size === targets.length);

/** Private durable state; a receipt alone cannot approve or dispatch an update. */
export const hostUpdateOperationSchema = z
  .object({
    format: z.literal(1),
    id: z.uuid(),
    revision: z.number().int().positive().safe(),
    created_at: timestamp,
    updated_at: timestamp,
    phase: z.enum([
      'checking',
      'downloading',
      'staged',
      'preflight',
      'approved',
      'dispatching',
      'applying',
      'verifying',
      'complete',
      'blocked',
      'cancelled',
      'superseded',
      'failed',
      'recovery_required',
      'rolled_back',
    ]),
    targets: hostUpdateTargetsSchema,
    stages: z.array(hostStageReceiptSchema).max(2),
    preflight: fingerprint.nullable(),
    approved: fingerprint.nullable(),
    dispatch_id: z.uuid().nullable(),
    worker_id: z.uuid().nullable(),
    verification: fingerprint.nullable(),
    message: z.string().max(1024).nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    const fail = (message: string) => context.addIssue({ code: 'custom', message });
    if (record.updated_at < record.created_at) fail('Update timestamp moved backwards');
    if (
      ['blocked', 'cancelled', 'superseded', 'failed'].includes(record.phase) &&
      (record.dispatch_id !== null || record.worker_id !== null)
    )
      fail('A dispatched update requires verified recovery before becoming terminal');
    const components = new Set<string>();
    for (const stage of record.stages) {
      if (
        !stage.record.checksum_verified ||
        !record.targets.some(
          (target) =>
            target.component === stage.record.component && target.version === stage.record.version,
        ) ||
        components.has(stage.record.component)
      )
        fail('Stage does not match a verified update target');
      components.add(stage.record.component);
    }
    const prepared = [
      'staged',
      'preflight',
      'approved',
      'dispatching',
      'applying',
      'verifying',
      'complete',
      'recovery_required',
      'rolled_back',
    ].includes(record.phase);
    if (prepared && record.stages.length !== record.targets.length)
      fail('Update is not completely staged');
    if (
      [
        'preflight',
        'approved',
        'dispatching',
        'applying',
        'verifying',
        'complete',
        'recovery_required',
        'rolled_back',
      ].includes(record.phase) &&
      !record.preflight
    )
      fail('Update requires preflight evidence');
    if (
      [
        'approved',
        'dispatching',
        'applying',
        'verifying',
        'complete',
        'recovery_required',
        'rolled_back',
      ].includes(record.phase) &&
      record.approved !== record.preflight
    )
      fail('Update approval does not match preflight');
    if (
      [
        'dispatching',
        'applying',
        'verifying',
        'complete',
        'recovery_required',
        'rolled_back',
      ].includes(record.phase) &&
      !record.dispatch_id
    )
      fail('Update requires a recorded dispatch');
    if (['applying', 'verifying', 'complete'].includes(record.phase) && !record.worker_id)
      fail('Update requires a claimed worker');
    if (['complete', 'rolled_back'].includes(record.phase) && !record.verification)
      fail('Update requires verification evidence');
  });

export const HOST_UPDATE_HISTORY_LIMIT = 32;
export const HOST_UPDATE_RECORD_BYTES = 512 * 1024;
export const hostUpdateLedgerSchema = z
  .object({
    format: z.literal(1),
    current: hostUpdateOperationSchema.nullable(),
    history: z.array(hostUpdateOperationSchema).max(HOST_UPDATE_HISTORY_LIMIT),
  })
  .strict()
  .superRefine((ledger, context) => {
    const ids = [ledger.current?.id, ...ledger.history.map((operation) => operation.id)].filter(
      Boolean,
    );
    if (
      new Set(ids).size !== ids.length ||
      ledger.history.some((operation) => !hostUpdateTerminal(operation.phase))
    )
      context.addIssue({ code: 'custom', message: 'Invalid update history' });
  });

export type HostUpdateOperation = z.infer<typeof hostUpdateOperationSchema>;
export type HostUpdateLedger = z.infer<typeof hostUpdateLedgerSchema>;
export type HostUpdateTargets = z.infer<typeof hostUpdateTargetsSchema>;
export function hostUpdateTerminal(phase: HostUpdateOperation['phase']): boolean {
  return ['complete', 'blocked', 'cancelled', 'superseded', 'failed', 'rolled_back'].includes(
    phase,
  );
}
