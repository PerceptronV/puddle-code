import {
  canonicalHuddleJson,
  huddleJsonSchema,
  puddlangAskSchema,
  type RuntimePlacement,
  type RuntimeTurnResult,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import type { Db } from '../../../db/db.js';
import { RuntimeObservationStore } from '../../../db/stores/runtime-observations.js';
import { reserveRuntimeTurn } from '../../../db/stores/runtime-results/admission.js';
import type { ResultCapacityLimits } from '../../../db/stores/runtime-results/limits.js';
import { ApiError } from '../../../http/errors.js';
import type { RuntimeTurnCaller } from '../../../runtime/controller/turns/caller.js';
import { huddleTurnScopeSchema, type HuddleTurnScope, type HuddleTurnAuthority } from './scope.js';
import { HUDDLE_TURN_BINDING_LIMITS, type HuddleTurnBindingLimits } from './limits.js';
import { requireHuddleTurnScope, requireHuddleTurnAuthority } from './authority.js';

interface Mapping {
  intent: string;
  runtime_id: string;
  turn: number;
  session_id: string;
  segment_id: string;
  expected_ref: string | null;
  receipt: string | null;
}

/** Durable host admission, separate from the owner's node ledger and from daemon-owned programmes. */
export class HuddleTurnStore {
  constructor(
    private readonly db: Db,
    private readonly limits?: ResultCapacityLimits,
    private readonly bindings: HuddleTurnBindingLimits = HUDDLE_TURN_BINDING_LIMITS,
  ) {
    for (const kind of ['execution', 'owner', 'host'] as const)
      if (
        !Number.isSafeInteger(bindings[kind]) ||
        bindings[kind] < 1 ||
        bindings[kind] > HUDDLE_TURN_BINDING_LIMITS[kind]
      )
        throw new Error('Invalid huddle turn binding limit');
  }

  bind(input: HuddleTurnScope, value: unknown, authorised: HuddleTurnAuthority) {
    const scope = huddleTurnScopeSchema.parse(input);
    const request = puddlangAskSchema.parse(structuredClone(huddleJsonSchema.parse(value)));
    const intent = canonicalHuddleJson({
      scope,
      request: digest(canonicalHuddleJson(huddleJsonSchema.parse(request))),
    });
    const { owner, target } = scope;
    const check = (dispatch: boolean) =>
      requireHuddleTurnScope(this.db, scope, authorised, dispatch ? 'dispatch' : 'observe');
    const mapping = (): Mapping => {
      const row = this.db
        .prepare(
          `SELECT intent, runtime_id, turn, session_id, segment_id, expected_ref, receipt
        FROM huddle_runtime_turns WHERE owner_runtime_id = ? AND operation_id = ?`,
        )
        .get(owner.runtime_id, scope.operationId) as Mapping | undefined;
      if (
        !row ||
        row.intent !== intent ||
        row.runtime_id !== target.runtimeId ||
        row.session_id !== target.sessionId ||
        !Number.isSafeInteger(row.turn) ||
        row.turn <= 0
      )
        throw ApiError.conflict('huddle_operation_changed', 'No matching admitted huddle turn');
      return row;
    };
    const result = (row: Mapping): RuntimeTurnResult | null => {
      const value = new RuntimeObservationStore(this.db).turn(row.runtime_id, row.turn);
      if (value && (value.turn !== row.turn || value.expected_ref !== row.expected_ref))
        throw new Error('Retained agent result differs from the admitted huddle turn');
      return value;
    };
    const receipt = (row: Mapping, value: RuntimeTurnResult | null) =>
      value && value.status !== 'running'
        ? digest(
            JSON.stringify({
              intent,
              runtimeId: row.runtime_id,
              turn: row.turn,
              sessionId: row.session_id,
              segmentId: row.segment_id,
              expectedRef: row.expected_ref,
              result: value,
            }),
          )
        : null;
    const caller: RuntimeTurnCaller = {
      check: (id) => {
        if (id !== target.runtimeId) throw new Error('Huddle turn target changed');
        check(true);
      },
      reserve: (id, placement, expectedRef, observedTurn) =>
        this.db.transaction(() => {
          caller.check(id);
          if (placement.session_id !== target.sessionId)
            throw new Error('Huddle agent placement changed');
          if (
            this.db
              .prepare(
                'SELECT 1 FROM huddle_runtime_turns WHERE owner_runtime_id = ? AND operation_id = ?',
              )
              .get(owner.runtime_id, scope.operationId)
          )
            throw ApiError.conflict(
              'operation_already_dispatched',
              'This huddle operation already has a turn identity; observe it without resubmitting',
            );
          const count = this.db
            .prepare(
              `SELECT COUNT(*) AS count FROM huddle_runtime_turns
          WHERE owner_runtime_id = ? AND execution_id = ?`,
            )
            .get(owner.runtime_id, scope.executionId) as { count: number };
          const ownerCount = this.db
            .prepare(
              'SELECT COUNT(*) AS count FROM huddle_runtime_turns WHERE owner_runtime_id = ?',
            )
            .get(owner.runtime_id) as { count: number };
          const hostCount = this.db
            .prepare('SELECT COUNT(*) AS count FROM huddle_runtime_turns')
            .get() as { count: number };
          if (
            count.count >= this.bindings.execution ||
            ownerCount.count >= this.bindings.owner ||
            hostCount.count >= this.bindings.host
          )
            throw new Error('Huddle turn binding retention is full');
          const turn = reserveRuntimeTurn(this.db, id, placement, observedTurn, this.limits);
          this.db
            .prepare(
              `INSERT INTO huddle_runtime_turns
          (owner_runtime_id, operation_id, execution_id, invocation_id, intent, runtime_id, turn, session_id, segment_id, expected_ref)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              owner.runtime_id,
              scope.operationId,
              scope.executionId,
              scope.invocationId,
              intent,
              id,
              turn,
              placement.session_id,
              placement.segment_id,
              expectedRef,
            );
          return turn;
        })(),
      // Reading never releases retention. The owner must first durably save and acknowledge the result.
      read: (id, turn) => {
        check(false);
        const row = mapping();
        if (row.runtime_id !== id || row.turn !== turn)
          throw new Error('Huddle turn identity changed');
        return result(row);
      },
      checkCancellation: (id, turn) => {
        check(false);
        const row = mapping();
        if (row.runtime_id !== id || row.turn !== turn)
          throw new Error('Huddle cancellation does not match its admitted turn');
      },
      releaseUnused: (
        id: string,
        placement: RuntimePlacement,
        expectedRef: string | null,
        turn: number,
      ) =>
        this.db.transaction(() => {
          // Internal proof from the dispatcher. Revocation cannot prevent releasing proven unused capacity.
          const row = mapping();
          if (
            row.runtime_id !== id ||
            row.turn !== turn ||
            row.session_id !== placement.session_id ||
            row.segment_id !== placement.segment_id ||
            row.expected_ref !== expectedRef
          )
            throw new Error('Unused huddle result reservation changed');
          this.db
            .prepare(
              `DELETE FROM runtime_result_charges WHERE runtime_id = ? AND turn = ?
          AND NOT EXISTS (SELECT 1 FROM runtime_turns WHERE runtime_id = ? AND turn = ?)`,
            )
            .run(id, turn, id, turn);
        })(),
    };
    return {
      target: target.runtimeId,
      request,
      caller,
      observe: () => {
        check(false);
        const row = mapping();
        const value = result(row);
        const current = receipt(row, value);
        if (row.receipt && current && row.receipt !== current)
          throw new Error('Acknowledged huddle result changed');
        return {
          runtimeId: row.runtime_id,
          turn: row.turn,
          result: value,
          receipt: current ?? row.receipt,
          acknowledged: row.receipt !== null,
        };
      },
      /** Private owner receipt only, after durable graph-ledger storage; never call on a mere host read. */
      acknowledge: (expected: string) =>
        this.db.transaction(() => {
          check(false);
          const row = mapping();
          if (row.receipt) {
            if (row.receipt !== expected) throw new Error('Huddle result acknowledgement changed');
            return;
          }
          if (!expected || receipt(row, result(row)) !== expected)
            throw new Error('Inspect an unchanged terminal huddle turn before acknowledging');
          requireHuddleTurnAuthority(authorised, 'observe');
          this.db
            .prepare(
              'UPDATE huddle_runtime_turns SET receipt = ? WHERE owner_runtime_id = ? AND operation_id = ?',
            )
            .run(expected, owner.runtime_id, scope.operationId);
          this.db
            .prepare('UPDATE runtime_turns SET consumed = 1 WHERE runtime_id = ? AND turn = ?')
            .run(row.runtime_id, row.turn);
        })(),
    };
  }
}
