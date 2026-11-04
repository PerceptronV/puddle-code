import { z } from 'zod';
import { parseHostReleaseVersion } from './version.js';

/** Private installer receipt, not a browser command or an update authorisation. */
export const hostStageRecordSchema = z
  .object({
    format: z.literal(1),
    component: z.enum(['daemon', 'runtime']),
    generation: z
      .string()
      .max(135)
      .regex(/^[A-Za-z0-9.+-]+~[A-Za-z0-9]{6}$/),
    version: z
      .string()
      .max(128)
      .refine((value) => parseHostReleaseVersion(value) === value),
    protocol: z
      .object({
        major: z.number().int().nonnegative().safe(),
        minor: z.number().int().nonnegative().safe(),
      })
      .strict(),
    archive_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    tree_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    checksum_verified: z.boolean(),
  })
  .strict()
  .refine((record) => record.generation.startsWith(`${record.version}~`));

export const hostStageReceiptSchema = z
  .object({
    record: hostStageRecordSchema,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type HostStageReceipt = z.infer<typeof hostStageReceiptSchema>;
