import {
  RUNTIME_LIMITS,
  runtimeTerminalSchema,
  runtimeTurnResultSchema,
  type RuntimeTerminal,
  type RuntimeTurnResult,
} from '@puddle/shared';
import type { Db } from '../db.js';
import type { RuntimeBinding } from './runtimes.js';
import { RuntimeResultCapacity } from './runtime-results/capacity.js';
import { RESULT_RESERVATION_BYTES, type ResultCapacityLimits } from './runtime-results/limits.js';

export interface RuntimeObservationState {
  captureEnabled: boolean;
  terminals: RuntimeTerminal[];
}

export class RuntimeObservationStore {
  private readonly capacity: RuntimeResultCapacity;
  constructor(
    private readonly db: Db,
    limits?: ResultCapacityLimits,
  ) {
    this.capacity = new RuntimeResultCapacity(db, limits);
  }

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
  reserveTurnCapacity(id: string, turn?: number): void {
    this.db.transaction(() => {
      if (turn === undefined) this.capacity.makeRoom(id, -1, RESULT_RESERVATION_BYTES);
      else this.capacity.reserve(id, turn, RESULT_RESERVATION_BYTES);
    })();
  }

  /** Runs inside the already fenced final-journal transaction, never from disconnected status. */
  retireResults(id: string): void {
    if (!this.db.inTransaction) throw new Error('Runtime result retirement requires final commit');
    this.capacity.retire(id);
  }

  /** Existing host maintenance owns scheduling and exclusion from daemon update checkpoints. */
  reclaimResults(): boolean {
    return this.capacity.maintain();
  }

  private writeTurn(binding: RuntimeBinding, value: RuntimeTurnResult): void {
    this.capacity.requireOpen(binding.runtime_id);
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
    this.db
      .prepare(
        `INSERT INTO runtime_turn_watermarks (runtime_id, turn) VALUES (?, ?)
      ON CONFLICT(runtime_id) DO UPDATE SET turn = MAX(turn, excluded.turn)`,
      )
      .run(binding.runtime_id, result.turn);
    this.capacity.retireUncreatable(binding.runtime_id, result.turn - 1);
    this.capacity.makeRoom(
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
  }
}
