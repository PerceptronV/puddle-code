import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalHuddleJson,
  huddleCompletionSourceSchema,
  huddleOperationRecordSchema,
  puddlangAskSchema,
  type HuddleCompletionSource,
  type HuddleOperationRecord,
  type RuntimeNativeTurnRecord,
} from '@puddle/shared';
import { HuddleStateDatabase } from '../state/database.js';

const inputSchema = z.strictObject({
  request: puddlangAskSchema,
  nativeCompletion: huddleCompletionSourceSchema,
});
export function nativeAskInput(input: HuddleOperationRecord['input']) {
  if (input && typeof input === 'object' && 'nativeCompletion' in input)
    return inputSchema.parse(input);
  return null;
}
const proofSchema = z.strictObject({
  turn: z.number().int().positive().safe(),
  sequence: z.number().int().positive().safe(),
  nativeTurnId: z.string().min(1).max(4096),
  event: z.enum(['completed', 'failed', 'interrupted']),
  replyHash: z.string().length(64).optional(),
  error: z.string().max(4096).optional(),
});
export const nativeReplyHash = (reply: string) => createHash('sha256').update(reply).digest('hex');

/** Confirmation is private operation evidence, never a new trigger root. */
export class HuddleNativeFeedback {
  constructor(private readonly db: HuddleStateDatabase) {}

  prepare(operation: HuddleOperationRecord) {
    if (operation.kind !== 'ask' || !nativeAskInput(operation.input)) return;
    // Reserve proof capacity in the same transaction as intent, before any external send.
    this.db.put('native-completions', operation.id, operation.executionId, 'waiting', null, {
      // Includes worst-case JSON escaping of native id and error strings.
      bytes: 64 * 1024,
    });
  }

  observe(source: HuddleCompletionSource, record: RuntimeNativeTurnRecord) {
    if (record.event === 'started' || record.origin.kind !== 'automation') return;
    const origin = record.origin.huddle;
    if (!origin || origin.huddleId !== this.db.identity.huddleId) return;
    const row = this.db.get('operations', origin.operationId);
    if (!row) return;
    const operation = huddleOperationRecordSchema.parse(JSON.parse(row.body));
    if (
      operation.kind !== 'ask' ||
      !operation.consumed ||
      operation.executionId !== origin.executionId
    )
      return;
    const input = nativeAskInput(operation.input);
    if (
      !input ||
      input.nativeCompletion.cursor.epoch !== source.cursor.epoch ||
      canonicalHuddleJson({ ...input.nativeCompletion, cursor: source.cursor }) !==
        canonicalHuddleJson(source) ||
      record.sequence <= input.nativeCompletion.cursor.sequence
    )
      return;
    const proof = proofSchema.parse({
      turn: record.origin.turn,
      sequence: record.sequence,
      nativeTurnId: record.nativeTurnId,
      event: record.event,
      ...(record.event === 'completed'
        ? { replyHash: nativeReplyHash(record.reply!) }
        : { error: record.error }),
    });
    const retained = this.db.get('native-completions', operation.id);
    if (!retained) throw new Error('Native confirmation has no retained reservation');
    if (retained.state === 'observed') {
      if (canonicalHuddleJson(JSON.parse(retained.body)) !== canonicalHuddleJson(proof))
        throw new Error('Native completion conflicts with retained operation evidence');
      return;
    }
    this.db.put('native-completions', operation.id, operation.executionId, 'observed', proof);
  }

  proof(id: string) {
    const row = this.db.get('native-completions', id);
    return row?.state === 'observed' ? proofSchema.parse(JSON.parse(row.body)) : null;
  }
}
