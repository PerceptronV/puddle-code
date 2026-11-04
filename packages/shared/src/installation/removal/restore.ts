import { z } from 'zod';
import type { HostRemovalServices } from './services.js';

export const hostRemovalRestoreActionSchema = z.enum([
  'restore-connector',
  'restore-daemon',
  'reload-services',
  'enable-connector',
  'enable-daemon',
  'restore-supervisor',
]);
export type HostRemovalRestoreAction = z.infer<typeof hostRemovalRestoreActionSchema>;

/** The same exact plan is used by dispatch and passive post-hand-off inspection. */
export function hostRemovalRestorePlan(
  removal: HostRemovalServices,
  purged = false,
): HostRemovalRestoreAction[] {
  const present = (['connector', 'daemon'] as const).filter((component) =>
    removal.services.some(({ review }) => review.component === component),
  );
  const systemd = present.filter((component) =>
    removal.services.some(
      ({ review }) => review.component === component && review.target.kind === 'systemd',
    ),
  );
  return [
    ...present.map((component): HostRemovalRestoreAction => `restore-${component}`),
    ...(systemd.length ? ['reload-services' as const] : []),
    ...systemd.map((component): HostRemovalRestoreAction => `enable-${component}`),
    ...(purged ? ['restore-supervisor' as const] : []),
  ];
}

/** Private, explicit configuration restoration; never a runtime restart or database rollback. */
export const hostRemovalRestoreSchema = z
  .object({
    format: z.literal(1),
    removal_id: z.uuid(),
    removal_digest: z.string().regex(/^[0-9a-f]{64}$/),
    /** Exact completed purge proof; absent on historical ordinary restoration journals. */
    purge_digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    actions: z
      .array(
        z
          .object({
            action: hostRemovalRestoreActionSchema,
            state: z.enum(['planned', 'started', 'finished']),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      Boolean(record.purge_digest) !==
      record.actions.some(({ action }) => action === 'restore-supervisor')
    )
      context.addIssue({
        code: 'custom',
        message: 'Supervisor restoration requires completed purge evidence',
      });
    if (new Set(record.actions.map(({ action }) => action)).size !== record.actions.length)
      context.addIssue({ code: 'custom', message: 'Duplicate restoration action' });
    let unfinished = false;
    for (const { state } of record.actions) {
      if (unfinished && state !== 'planned')
        context.addIssue({
          code: 'custom',
          message: 'Restoration actions are not a serial prefix',
        });
      if (state !== 'finished') unfinished = true;
    }
  });
export type HostRemovalRestore = z.infer<typeof hostRemovalRestoreSchema>;
