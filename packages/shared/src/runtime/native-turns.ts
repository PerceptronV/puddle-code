import { z } from 'zod';

export const NATIVE_TURN_LIMITS = Object.freeze({
  records: 128,
  bytes: 2 * 1024 * 1024,
  page: 16,
  replyBytes: 256 * 1024,
});
const sequence = z.number().int().nonnegative().safe();
export const runtimeTurnOriginSchema = z.strictObject({
  huddleId: z.string().regex(/^[a-f0-9]{32}$/),
  executionId: z.uuid(),
  operationId: z.uuid(),
});
export type RuntimeTurnOrigin = z.infer<typeof runtimeTurnOriginSchema>;
export const agentTurnContextSchema = z.strictObject({
  turn: sequence.refine((value) => value > 0),
  huddle: runtimeTurnOriginSchema.optional(),
});
export type AgentTurnContext = z.infer<typeof agentTurnContextSchema>;
const observation = {
  event: z.enum(['started', 'completed', 'failed', 'interrupted']),
  agentSessionRef: z.string().min(1).max(200),
  nativeTurnId: z.string().min(1).max(4096),
  reply: z
    .string()
    .max(NATIVE_TURN_LIMITS.replyBytes)
    .refine((value) => new TextEncoder().encode(value).length <= NATIVE_TURN_LIMITS.replyBytes)
    .optional(),
  error: z.string().min(1).max(4096).optional(),
};
function validOutcome(value: { event: string; reply?: string; error?: string }) {
  return value.event === 'completed'
    ? value.reply !== undefined && value.error === undefined
    : value.reply === undefined &&
        (value.event === 'started' ? value.error === undefined : value.error !== undefined);
}
/** Adapter observations are accepted only after exact native identity/correlation checks. */
export const agentNativeTurnSchema = z
  .strictObject({
    ...observation,
    automated: z.boolean(),
    automation: agentTurnContextSchema.optional(),
  })
  .refine(validOutcome, 'Native turn outcome fields do not match')
  .refine(
    (value) => value.automated || value.automation === undefined,
    'External turns cannot claim automated context',
  );
export type AgentNativeTurn = z.infer<typeof agentNativeTurnSchema>;
export const runtimeNativeTurnCursorSchema = z.strictObject({
  epoch: z.string().regex(/^[a-f0-9]{32}$/),
  sequence,
});
export type RuntimeNativeTurnCursor = z.infer<typeof runtimeNativeTurnCursorSchema>;
export const runtimeNativeTurnRecordSchema = z
  .strictObject({
    ...observation,
    sequence: sequence.refine((value) => value > 0),
    observedAt: z.iso.datetime(),
    segmentId: z.uuid(),
    sessionId: z.uuid().nullable(),
    origin: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('external') }),
      z.strictObject({ kind: z.literal('unknown') }),
      agentTurnContextSchema.extend({ kind: z.literal('automation') }),
    ]),
  })
  .refine(validOutcome, 'Native turn outcome fields do not match');
export type RuntimeNativeTurnRecord = z.infer<typeof runtimeNativeTurnRecordSchema>;
export const runtimeNativeTurnStatusSchema = z
  .strictObject({
    version: z.literal(1),
    cursor: runtimeNativeTurnCursorSchema,
    floor: sequence,
    persistencePending: z.boolean(),
  })
  .refine((value) => value.floor <= value.cursor.sequence, 'Native turn floor exceeds head');
export const runtimeNativeTurnPageSchema = z
  .discriminatedUnion('state', [
    z.strictObject({
      state: z.literal('baseline'),
      cursor: runtimeNativeTurnCursorSchema,
      persistencePending: z.boolean(),
    }),
    z.strictObject({
      state: z.literal('gap'),
      cursor: runtimeNativeTurnCursorSchema,
      floor: sequence,
      reason: z.enum(['epoch', 'retention', 'ahead']),
      persistencePending: z.boolean(),
    }),
    z.strictObject({
      state: z.literal('events'),
      cursor: runtimeNativeTurnCursorSchema,
      head: sequence,
      records: z.array(runtimeNativeTurnRecordSchema).max(NATIVE_TURN_LIMITS.page),
      persistencePending: z.boolean(),
    }),
  ])
  .superRefine((page, context) => {
    if (
      (page.state === 'gap' && page.floor > page.cursor.sequence) ||
      (page.state === 'events' &&
        (page.cursor.sequence > page.head ||
          page.records.some(
            (record, i) =>
              record.sequence > page.cursor.sequence ||
              (i > 0 && record.sequence <= page.records[i - 1]!.sequence),
          )))
    )
      context.addIssue({
        code: 'custom',
        message: 'Native turn page is not ordered within its checkpoint',
      });
    if (new TextEncoder().encode(JSON.stringify(page)).length > NATIVE_TURN_LIMITS.bytes)
      context.addIssue({ code: 'custom', message: 'Native turn page exceeds its byte limit' });
  });
export type RuntimeNativeTurnPage = z.infer<typeof runtimeNativeTurnPageSchema>;
