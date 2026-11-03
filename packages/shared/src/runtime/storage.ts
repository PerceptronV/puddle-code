import { z } from 'zod';
import {
  RUNTIME_LIMITS,
  runtimeCommandSchema,
  runtimeCaptureSchema,
  runtimeIdentitySchema,
  runtimeJournalStatusSchema,
  runtimeProviderLaunchSchema,
  runtimeRetainedEventSchema,
} from './protocol.js';

/** Immutable helper inventory; release collection must retain its exact Node executable. */
export const runtimeAssetsSchema = z.object({
  format: z.literal(1),
  node_path: z
    .string()
    .max(4096)
    .refine((value) => value.startsWith('/') && !value.includes('\0')),
  files: z
    .record(z.string().regex(/^[a-z0-9][a-z0-9-]*\.(mjs|js)$/), z.string().regex(/^[a-f0-9]{64}$/))
    .refine((value) => Object.keys(value).length <= 16),
});

/** Only the runtime writes this record; application effects remain in puddled's database. */
export const runtimeJournalSchema = z
  .object({
    format: z.literal(1),
    identity: runtimeIdentitySchema,
    cursor: runtimeJournalStatusSchema.shape.cursor,
    acknowledged: runtimeJournalStatusSchema.shape.acknowledged,
    lost_through: runtimeJournalStatusSchema.shape.lost_through,
    events: z.array(runtimeRetainedEventSchema).max(RUNTIME_LIMITS.journalEvents),
  })
  .superRefine((record, ctx) => {
    let previous = record.acknowledged;
    if (record.acknowledged > record.cursor || record.lost_through > record.cursor)
      ctx.addIssue({ code: 'custom', message: 'Journal cursor exceeds its head' });
    for (const event of record.events) {
      if (event.cursor <= previous || event.cursor > record.cursor)
        ctx.addIssue({ code: 'custom', message: 'Journal events must be strictly ordered' });
      previous = event.cursor;
    }
  });
export type RuntimeJournalRecord = z.infer<typeof runtimeJournalSchema>;

/** Private launch input, consumed once. Contains environment/secrets; never expose via discovery. */
export const runtimeLaunchSchema = z.object({
  format: z.literal(1),
  identity: runtimeIdentitySchema,
  secret: z.string().regex(/^[a-f0-9]{64}$/),
  main: runtimeCommandSchema,
  provider: runtimeProviderLaunchSchema.optional(),
  capture_env: runtimeCaptureSchema.optional(),
});
export type RuntimeLaunch = z.infer<typeof runtimeLaunchSchema>;

/** Written under the runtime claim to fence a delayed launcher after confirmed owner loss. */
export const runtimeRetiredSchema = z.object({
  format: z.literal(1),
  identity: runtimeIdentitySchema,
});

export const runtimeControllerSchema = z.object({
  format: z.literal(1),
  id: z.uuid(),
  epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  active: z.boolean(),
});
export type RuntimeControllerRecord = z.infer<typeof runtimeControllerSchema>;

/** Registration metadata contains no provider credentials or launch environment. */
export const runtimeSupervisorSchema = z.object({
  format: z.literal(1),
  identity: runtimeIdentitySchema,
  kind: z.enum(['systemd', 'launchd']),
  name: z
    .string()
    .regex(
      /^(puddler-[a-f0-9]{8}-[a-f0-9-]{36}\.service|dev\.puddle\.runtime\.[a-f0-9]{8}\.[a-f0-9-]{36})$/,
    ),
  domain: z
    .string()
    .regex(/^gui\/[0-9]+$/)
    .nullable(),
  node_path: z.string().max(4096),
  entry_path: z.string().max(4096),
  state: z.enum(['dispatching', 'dispatched', 'removed']),
});
export type RuntimeSupervisor = z.infer<typeof runtimeSupervisorSchema>;
