import {
  RUNTIME_LIMITS,
  runtimeTerminalSchema,
  runtimeTurnResultSchema,
  type RuntimeTerminal,
  type RuntimeTurnResult,
} from '@puddle/shared';
import type { Db } from '../db.js';
import type { RuntimeBinding } from './runtimes.js';

export interface RuntimeObservationState {
  captureEnabled: boolean;
  terminals: RuntimeTerminal[];
}

/** Only outcomes explicitly consumed by a programme may yield space to newer turns. */
export const RUNTIME_RESULT_LIMITS = { turns: 128, bytes: 16 * 1024 * 1024 } as const;
// Worst-case JSON escaping, matching the owner's journal reservation. Keep room
// for the final outcome before admitting its much smaller running observation.
const RESULT_RESERVATION_BYTES = 6 * RUNTIME_LIMITS.turnReplyBytes + 32 * 1024;

export class RuntimeObservationStore {
  constructor(private readonly db: Db) {}

  get(id: string): RuntimeObservationState | null {
    const row = this.db
      .prepare('SELECT capture_enabled, terminals FROM runtime_observations WHERE runtime_id = ?')
      .get(id) as { capture_enabled: number; terminals: string } | undefined;
    return row
      ? {
          captureEnabled: row.capture_enabled === 1,
          terminals: runtimeTerminalSchema
            .array()
            .max(RUNTIME_LIMITS.terminals)
            .parse(JSON.parse(row.terminals) as unknown),
        }
      : null;
  }

  save(id: string, state: RuntimeObservationState): void {
    const terminals = runtimeTerminalSchema
      .array()
      .max(RUNTIME_LIMITS.terminals)
      .parse(state.terminals);
    if (new Set(terminals.map((term) => term.term)).size !== terminals.length)
      throw new Error('Duplicate runtime terminal name');
    this.db
      .prepare(
        `INSERT INTO runtime_observations (runtime_id, capture_enabled, terminals) VALUES (?, ?, ?)
      ON CONFLICT(runtime_id) DO UPDATE SET capture_enabled = excluded.capture_enabled, terminals = excluded.terminals`,
      )
      .run(id, Number(state.captureEnabled), JSON.stringify(terminals));
  }

  bindTerminal(segmentId: string, terminal: RuntimeTerminal): void {
    this.db
      .prepare(
        `INSERT INTO runtime_segment_terminals (segment_id, term, generation) VALUES (?, ?, ?)
      ON CONFLICT(segment_id, term) DO UPDATE SET generation = excluded.generation`,
      )
      .run(segmentId, terminal.term, terminal.generation);
  }

  turn(id: string, turn: number): RuntimeTurnResult | null {
    const row = this.db
      .prepare('SELECT result FROM runtime_turns WHERE runtime_id = ? AND turn = ?')
      .get(id, turn) as { result: string } | undefined;
    return row ? runtimeTurnResultSchema.parse(JSON.parse(row.result) as unknown) : null;
  }

  interruptRunning(binding: RuntimeBinding): void {
    const row = this.db
      .prepare(
        "SELECT turn FROM runtime_turns WHERE runtime_id = ? AND json_extract(result, '$.status') = 'running'",
      )
      .get(binding.runtime_id) as { turn: number } | undefined;
    if (!row) return;
    const current = this.turn(binding.runtime_id, row.turn)!;
    this.saveTurn(binding, {
      ...current,
      status: 'interrupted',
      error: 'Runtime owner ended without a retained turn outcome; execution was not replayed',
    });
  }

  saveTurn(binding: RuntimeBinding, value: RuntimeTurnResult): void {
    this.db.transaction(() => this.writeTurn(binding, value))();
  }

  /** Called inside programme admission's transaction, before provider dispatch. */
  reserveTurnCapacity(id: string): void {
    this.db.transaction(() => this.makeRoom(id, -1, RESULT_RESERVATION_BYTES))();
  }

  private writeTurn(binding: RuntimeBinding, value: RuntimeTurnResult): void {
    const result = runtimeTurnResultSchema.parse(value);
    const previous = this.turn(binding.runtime_id, result.turn);
    if (previous) {
      if (
        previous.status !== 'running' ||
        previous.expected_ref !== result.expected_ref ||
        result.status === 'running'
      )
        throw new Error('Runtime turn outcome is immutable');
    } else {
      const latest = this.db
        .prepare('SELECT turn FROM runtime_turn_watermarks WHERE runtime_id = ?')
        .get(binding.runtime_id) as { turn: number } | undefined;
      if (result.status !== 'running' || result.turn <= (latest?.turn ?? 0))
        throw new Error('Runtime turn has no ordered admission');
      const running = this.db
        .prepare(
          "SELECT 1 FROM runtime_turns WHERE runtime_id = ? AND json_extract(result, '$.status') = 'running'",
        )
        .get(binding.runtime_id);
      if (running) throw new Error('Runtime already has a running turn');
    }
    const json = JSON.stringify(result);
    const bytes = Buffer.byteLength(json);
    this.makeRoom(
      binding.runtime_id,
      result.turn,
      result.status === 'running' ? RESULT_RESERVATION_BYTES : bytes,
    );
    this.db
      .prepare(
        `INSERT INTO runtime_turns (runtime_id, turn, session_id, segment_id, result, bytes) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(runtime_id, turn) DO UPDATE SET result = excluded.result, bytes = excluded.bytes`,
      )
      .run(
        binding.runtime_id,
        result.turn,
        binding.active_session_id,
        binding.active_segment_id,
        json,
        bytes,
      );
    this.db
      .prepare(
        `INSERT INTO runtime_turn_watermarks (runtime_id, turn) VALUES (?, ?)
      ON CONFLICT(runtime_id) DO UPDATE SET turn = MAX(turn, excluded.turn)`,
      )
      .run(binding.runtime_id, result.turn);
  }

  private makeRoom(id: string, turn: number, bytes: number): void {
    const rows = this.db
      .prepare(
        `SELECT turn, bytes, consumed, json_extract(result, '$.status') AS status
      FROM runtime_turns WHERE runtime_id = ? AND turn != ? ORDER BY turn`,
      )
      .all(id, turn) as Array<{ turn: number; bytes: number; consumed: number; status: string }>;
    let count = rows.length;
    let retainedBytes = rows.reduce((total, row) => total + row.bytes, 0);
    const fits = () =>
      count < RUNTIME_RESULT_LIMITS.turns && retainedBytes + bytes <= RUNTIME_RESULT_LIMITS.bytes;
    const remove = this.db.prepare('DELETE FROM runtime_turns WHERE runtime_id = ? AND turn = ?');
    for (const row of rows) {
      if (fits()) return;
      if (!row.consumed || row.status === 'running') continue;
      remove.run(id, row.turn);
      count--;
      retainedBytes -= row.bytes;
    }
    if (!fits()) throw new Error('Private runtime result retention is full');
  }
}
