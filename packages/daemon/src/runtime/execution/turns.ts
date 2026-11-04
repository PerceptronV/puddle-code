import {
  RUNTIME_LIMITS,
  runtimeTurnResultSchema,
  type RuntimeRetainedEvent,
  type RuntimeTurn,
  type RuntimeTurnResult,
  type RuntimeRequest,
  type RuntimeLifecycle,
} from '@puddle/shared';
import type { AgentControl } from '../../agents/adapter.js';
import type { RuntimeJournal, RuntimeJournalReservation } from '../state/journal.js';

type TurnEvent =
  | Omit<Extract<RuntimeRetainedEvent, { t: 'turn-started' }>, 'cursor'>
  | Omit<Extract<RuntimeRetainedEvent, { t: 'turn-finished' }>, 'cursor'>;

export class RuntimeTurnError extends Error {
  constructor(
    readonly code: 'busy' | 'duplicate_request' | 'invalid_request' | 'result_unavailable',
    message: string,
  ) {
    super(message);
  }
}

/** One accepted provider operation survives controller loss; no input is ever replayed. */
export class RuntimeTurns {
  private current: RuntimeTurnResult | null = null;
  private active: {
    abort: AbortController;
    reservation: RuntimeJournalReservation;
    turn: number;
    boundRef: string | null;
  } | null = null;

  constructor(
    private readonly journal: RuntimeJournal,
    private readonly publish: (event: TurnEvent, reservation: RuntimeJournalReservation) => void,
  ) {}

  state(): RuntimeTurn | null {
    if (!this.current) return null;
    const { turn, status, expected_ref } = this.current;
    return { turn, status, expected_ref };
  }

  start(
    control: AgentControl | null,
    actualRef: string | null,
    request: Pick<
      Extract<RuntimeRequest, { t: 'start-turn' }>,
      'turn' | 'expected_ref' | 'prompt' | 'output_schema'
    >,
  ): RuntimeTurnResult {
    if (request.turn <= (this.current?.turn ?? 0))
      throw new RuntimeTurnError('duplicate_request', 'Runtime turn identity was already admitted');
    if (request.expected_ref !== actualRef)
      throw new RuntimeTurnError(
        'invalid_request',
        'Native conversation changed before turn admission',
      );
    if (this.active || !control?.ready)
      throw new RuntimeTurnError('busy', 'Agent is not ready for an automated turn');
    // Worst-case JSON escaping of a bounded reply plus status, error and the
    // admission event. Ordinary lifecycle traffic cannot consume this space.
    const reservation = this.journal.reserve(6 * RUNTIME_LIMITS.turnReplyBytes + 32 * 1024, 2);
    if (!reservation) throw new RuntimeTurnError('busy', 'Runtime result retention is unavailable');
    const abort = new AbortController();
    this.current = { turn: request.turn, expected_ref: request.expected_ref, status: 'running' };
    this.active = { abort, reservation, turn: request.turn, boundRef: actualRef };
    this.publish({ t: 'turn-started', turn: { ...this.state()!, status: 'running' } }, reservation);
    // Both synchronous adapter failure and async rejection become retained
    // outcomes. The command has been admitted and must not be submitted again.
    let result: Promise<string>;
    try {
      result = control.ask(request.prompt, abort.signal, request.output_schema);
    } catch (error) {
      result = Promise.reject(error);
    }
    void result.then(
      (reply) => {
        if (typeof reply !== 'string' || Buffer.byteLength(reply) > RUNTIME_LIMITS.turnReplyBytes) {
          this.finish(request.turn, 'failed', undefined, 'Provider result exceeds its byte limit');
        } else this.finish(request.turn, 'completed', reply);
      },
      (error: unknown) =>
        this.finish(
          request.turn,
          'failed',
          undefined,
          (error instanceof Error ? error.message : 'Provider turn failed').slice(0, 4096),
        ),
    );
    return { ...this.current };
  }

  result(turn: number): RuntimeTurnResult {
    if (turn !== this.current?.turn)
      throw new RuntimeTurnError(
        'result_unavailable',
        'Turn result is unavailable; inspect retained events without resubmitting',
      );
    return { ...this.current };
  }

  cancel(turn: number): void {
    this.result(turn); // A stale cancellation must not reach a replacement turn.
    if (!this.active) return;
    const abort = this.active.abort;
    this.finish(turn, 'cancelled', undefined, 'Automated turn cancelled');
    abort.abort();
  }

  interrupt(reason: string): void {
    if (!this.active) return;
    const { turn, abort } = this.active;
    this.finish(turn, 'interrupted', undefined, reason.slice(0, 4096));
    abort.abort();
  }

  lifecycle(event: RuntimeLifecycle): void {
    if (!this.active) return;
    if (event.event === 'session_end') {
      this.interrupt('Agent ended its native conversation');
    } else if (event.agent_session_ref !== undefined) {
      if (this.active.boundRef === null) this.active.boundRef = event.agent_session_ref;
      else if (event.agent_session_ref !== this.active.boundRef)
        this.interrupt('Agent changed its native conversation');
    }
  }

  private finish(
    turn: number,
    status: Exclude<RuntimeTurn['status'], 'running'>,
    reply?: string,
    error?: string,
  ): void {
    if (this.active?.turn !== turn || !this.current) return;
    const { reservation } = this.active;
    this.active = null;
    this.current = runtimeTurnResultSchema.parse({
      ...this.current,
      status,
      ...(reply !== undefined ? { reply } : {}),
      ...(error !== undefined ? { error } : {}),
    });
    try {
      this.publish({ t: 'turn-finished', result: { ...this.current } }, reservation);
    } finally {
      reservation.release();
    }
  }
}
