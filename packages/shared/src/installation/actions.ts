import { z } from 'zod';

/** Internal update-worker steps, never client-supplied commands or runtime state. */
export const hostUpdateActionSchema = z.enum([
  'stop-connector',
  'stop-daemon',
  'select-daemon',
  'select-runtime',
  'start-daemon',
  'start-connector',
]);

export const hostUpdateActionsSchema = z
  .object({
    format: z.literal(1),
    operation_id: z.uuid(),
    dispatch_id: z.uuid(),
    worker_id: z.uuid(),
    preflight: z.string().regex(/^[0-9a-f]{64}$/),
    actions: z
      .array(
        z
          .object({
            action: hostUpdateActionSchema,
            state: z.enum(['planned', 'started', 'finished']),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict()
  .superRefine((record, context) => {
    const names = record.actions.map(({ action }) => action);
    if (new Set(names).size !== names.length)
      context.addIssue({ code: 'custom', message: 'Duplicate update action' });
    let unfinished = false;
    for (const { state } of record.actions) {
      if (unfinished && state !== 'planned')
        context.addIssue({ code: 'custom', message: 'Update actions are not a serial prefix' });
      if (state !== 'finished') unfinished = true;
    }
  });

export type HostUpdateAction = z.infer<typeof hostUpdateActionSchema>;
export type HostUpdateActionJournal = z.infer<typeof hostUpdateActionsSchema>;
