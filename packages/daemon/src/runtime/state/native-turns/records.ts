import { join } from 'node:path';
import { z } from 'zod';
import {
  NATIVE_TURN_LIMITS,
  runtimeIdentitySchema,
  runtimeNativeTurnRecordSchema,
  runtimeNativeTurnCursorSchema,
  type RuntimeIdentity,
} from '@puddle/shared';
import { readPrivateJson } from '@puddle/shared/node';

export const nativeTurnJournalSchema = z
  .strictObject({
    format: z.literal(1),
    identity: runtimeIdentitySchema,
    cursor: runtimeNativeTurnCursorSchema,
    floor: z.number().int().nonnegative().safe(),
    records: z.array(runtimeNativeTurnRecordSchema).max(NATIVE_TURN_LIMITS.records),
  })
  .superRefine((record, context) => {
    if (
      record.floor > record.cursor.sequence ||
      record.records.some(
        (value, i) =>
          value.sequence > record.cursor.sequence ||
          (i > 0 && value.sequence <= record.records[i - 1]!.sequence),
      )
    )
      context.addIssue({ code: 'custom', message: 'Invalid native turn journal order' });
  });
export type NativeTurnJournalRecord = z.infer<typeof nativeTurnJournalSchema>;
export function readNativeTurnJournal(directory: string, identity: RuntimeIdentity) {
  const record = nativeTurnJournalSchema.parse(
    readPrivateJson(join(directory, 'native-turns.json'), NATIVE_TURN_LIMITS.bytes),
  );
  for (const key of Object.keys(identity) as Array<keyof RuntimeIdentity>)
    if (record.identity[key] !== identity[key])
      throw new Error('Native turn journal identity changed');
  if (Buffer.byteLength(JSON.stringify(record)) + 1 > NATIVE_TURN_LIMITS.bytes)
    throw new Error('Native turn journal exceeds its byte limit');
  return record;
}
