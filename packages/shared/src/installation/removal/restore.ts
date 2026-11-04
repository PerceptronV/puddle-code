import { z } from 'zod';

export const hostRemovalRestoreActionSchema = z.enum([
  'restore-connector',
  'restore-daemon',
  'reload-services',
  'enable-connector',
  'enable-daemon',
]);
export type HostRemovalRestoreAction = z.infer<typeof hostRemovalRestoreActionSchema>;

/** Private, explicit configuration restoration; never a runtime restart or database rollback. */
export const hostRemovalRestoreSchema = z
  .object({
    format: z.literal(1),
    removal_id: z.uuid(),
    removal_digest: z.string().regex(/^[0-9a-f]{64}$/),
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
      .max(5),
  })
  .strict()
  .superRefine((record, context) => {
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
