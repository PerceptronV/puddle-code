import {
  puddlangOutcomeOperationSchema,
  puddlangOutcomeRequestSchema,
  puddlangOutcomeSchema,
  puddlangOutcomeResponseSchema,
  runtimeTurnResultSchema,
  type PuddlangOutcome,
  type PuddlangOutcomeRequest,
  type RuntimeTurnResult,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import type { Db } from '../../db/db.js';
import { ApiError } from '../../http/errors.js';

interface Mapping {
  operation_id: number;
  runtime_id: string;
  turn: number;
  session_id: string;
  segment_id: string;
  expected_ref: string | null;
}
interface Disposition {
  action: PuddlangOutcomeRequest['action'];
  fingerprint: string;
  status: Exclude<RuntimeTurnResult['status'], 'running'>;
  disposed_at: string;
}
const conflict = (message: string) => ApiError.conflict('outcome_changed', message);

/** Human inspection is separate from live runner authority and never calls the runtime. */
export class ProgrammeOutcomeStore {
  constructor(
    private readonly db: Db,
    private readonly event: (runId: string, type: string, data: unknown) => void,
  ) {}

  private run(profile: string, id: string): string {
    const row = this.db
      .prepare('SELECT status FROM puddlang_runs WHERE id = ? AND profile_id = ?')
      .get(id, profile) as { status: string } | undefined;
    if (!row) throw ApiError.notFound('puddlang run', id);
    return row.status;
  }

  private mapping(profile: string, id: string, operation: number): Mapping {
    puddlangOutcomeOperationSchema.parse(operation);
    const row = this.db
      .prepare(
        `SELECT t.operation_id, t.runtime_id, t.turn, t.session_id, t.segment_id, t.expected_ref FROM puddlang_runtime_turns t
      JOIN runtime_bindings r ON r.runtime_id = t.runtime_id
      WHERE t.run_id = ? AND t.operation_id = ? AND r.profile_id = ?`,
      )
      .get(id, operation, profile) as Mapping | undefined;
    if (!row) throw ApiError.notFound('programme outcome', String(operation));
    return row;
  }

  private inspect(profile: string, id: string, mapping: Mapping) {
    const row = this.db
      .prepare('SELECT result, consumed FROM runtime_turns WHERE runtime_id = ? AND turn = ?')
      .get(mapping.runtime_id, mapping.turn) as { result: string; consumed: number } | undefined;
    const result = row ? runtimeTurnResultSchema.parse(JSON.parse(row.result)) : null;
    if (result && (result.turn !== mapping.turn || result.expected_ref !== mapping.expected_ref))
      throw conflict('Retained outcome no longer matches its admitted operation');
    const prior = this.db
      .prepare('SELECT * FROM puddlang_outcome_dispositions WHERE run_id = ? AND operation_id = ?')
      .get(id, mapping.operation_id) as Disposition | undefined;
    const fingerprint =
      result && result.status !== 'running'
        ? digest(JSON.stringify({ profile, run: id, mapping, result }))
        : null;
    if (prior && fingerprint && prior.fingerprint !== fingerprint)
      throw conflict('Disposed outcome evidence changed');
    const outcome: PuddlangOutcome = puddlangOutcomeSchema.parse({
      operation_id: mapping.operation_id,
      runtime_id: mapping.runtime_id,
      turn: mapping.turn,
      status: result?.status ?? prior?.status ?? 'unavailable',
      retained: !!row,
      consumed: row ? row.consumed === 1 : prior ? true : null,
      fingerprint: fingerprint ?? prior?.fingerprint ?? null,
      disposition: prior
        ? { action: prior.action, fingerprint: prior.fingerprint, at: prior.disposed_at }
        : null,
    });
    return { result, outcome, prior };
  }

  list(profile: string, id: string, after?: number) {
    this.run(profile, id);
    if (after !== undefined) puddlangOutcomeOperationSchema.parse(after);
    const rows = this.db
      .prepare(
        `SELECT operation_id FROM puddlang_runtime_turns
      WHERE run_id = ? AND (? IS NULL OR operation_id > ?) ORDER BY operation_id LIMIT 51`,
      )
      .all(id, after ?? null, after ?? null) as Array<{ operation_id: number }>;
    const outcomes = rows
      .slice(0, 50)
      .map(
        ({ operation_id }) =>
          this.inspect(profile, id, this.mapping(profile, id, operation_id)).outcome,
      );
    return { outcomes, next_after: rows.length > 50 ? outcomes.at(-1)!.operation_id : null };
  }

  dispose(
    profile: string,
    id: string,
    operation: number,
    input: PuddlangOutcomeRequest,
    authorised: () => boolean,
  ) {
    const request = puddlangOutcomeRequestSchema.parse(input);
    const requireAuthority = () => {
      if (!authorised())
        throw new ApiError(401, 'upstream_expired', 'Connection authority expired');
    };
    return this.db.transaction(() => {
      requireAuthority();
      if (this.run(profile, id) === 'running')
        throw conflict('Wait for the programme to finish before disposing of its outcomes');
      const mapping = this.mapping(profile, id, operation);
      const { result, outcome, prior } = this.inspect(profile, id, mapping);
      if (prior) {
        if (prior.action !== request.action || prior.fingerprint !== request.fingerprint)
          throw conflict('This outcome already has a different explicit disposition');
      } else {
        if (!result || result.status === 'running' || outcome.fingerprint !== request.fingerprint)
          throw conflict(
            'Inspect an unchanged retained terminal outcome before reading or discarding it',
          );
        requireAuthority();
        const at = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO puddlang_outcome_dispositions
          (run_id, operation_id, action, fingerprint, status, disposed_at) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(id, operation, request.action, request.fingerprint, result.status, at);
        this.db
          .prepare('UPDATE runtime_turns SET consumed = 1 WHERE runtime_id = ? AND turn = ?')
          .run(mapping.runtime_id, mapping.turn);
        this.event(id, 'outcome_disposition', {
          operation_id: operation,
          runtime_id: mapping.runtime_id,
          turn: mapping.turn,
          action: request.action,
          fingerprint: request.fingerprint,
          status: result.status,
          at,
        });
        outcome.consumed = true;
        outcome.disposition = { ...request, at };
      }
      requireAuthority();
      return puddlangOutcomeResponseSchema.parse({
        outcome,
        result:
          request.action === 'read' && result && result.status !== 'running'
            ? {
                status: result.status,
                ...(result.reply !== undefined ? { reply: result.reply } : {}),
                ...(result.error !== undefined ? { error: result.error } : {}),
              }
            : null,
      });
    })();
  }
}
