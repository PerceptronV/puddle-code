import { z } from 'zod';
import {
  canonicalHuddleJson,
  runtimeIdentitySchema,
  type HuddleOperationRecord,
  type RuntimeIdentity,
} from '@puddle/shared';
import type { HuddleStateDatabase } from './database.js';

const originSchema = z.strictObject({
  format: z.literal(1),
  invocationId: z.uuid(),
  owner: runtimeIdentitySchema,
});

/** Immutable caller provenance, committed in the same transaction as host-operation intent. */
export class HuddleOperationOrigins {
  constructor(private readonly db: HuddleStateDatabase) {}

  private owner(raw: RuntimeIdentity): RuntimeIdentity {
    const owner = runtimeIdentitySchema.parse(raw);
    const scope = this.db.identity;
    if (
      owner.runtime_id !== scope.runtimeId ||
      owner.profile_id !== scope.profileId ||
      owner.project_id !== scope.projectId ||
      owner.session_id !== scope.sessionId
    )
      throw new Error('Huddle operation origin differs from its ledger placement');
    return owner;
  }

  get(operation: HuddleOperationRecord): RuntimeIdentity | null {
    const row = this.db.get('operation-origins', operation.id);
    if (!row) return null;
    const origin = originSchema.parse(JSON.parse(row.body));
    if (row.parent !== operation.executionId || origin.invocationId !== operation.invocationId)
      throw new Error('Huddle operation origin differs from retained intent');
    return this.owner(origin.owner);
  }

  prepare(operation: HuddleOperationRecord, raw: RuntimeIdentity) {
    if (!['ask', 'spawn'].includes(operation.kind))
      throw new Error('Only host agent operations have an owner origin');
    const owner = this.owner(raw);
    const previous = this.get(operation);
    if (previous) {
      if (canonicalHuddleJson(previous) !== canonicalHuddleJson(owner))
        throw new Error('Huddle operation origin is immutable');
      return;
    }
    this.db.put('operation-origins', operation.id, operation.executionId, 'retained', {
      format: 1,
      invocationId: operation.invocationId,
      owner,
    });
  }
}
