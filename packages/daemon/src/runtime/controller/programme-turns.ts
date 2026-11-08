import { setTimeout as delay } from 'node:timers/promises';
import { runtimeRequestSchema, type RuntimePlacement } from '@puddle/shared';
import type { RuntimeStore } from '../../db/stores/runtimes.js';
import { ApiError } from '../../http/errors.js';
import { ProgrammeTurnStore, type ProgrammeOperation } from '../../puddlang/runtime-turn-store.js';
import {
  RuntimeConnectionLost,
  RuntimeRequestRejected,
  type RuntimeClient,
} from '../transport/client.js';
import type { RuntimeConnections } from '../transport/connections.js';
import type { RuntimeReconciler } from './reconcile.js';
import type { RuntimeTurnCaller } from './turns/caller.js';

interface Target {
  id: string;
  placement: RuntimePlacement;
  client: RuntimeClient;
}

/** Programme callers persist admission identity, send once and consume committed outcomes. */
export class RuntimeProgrammeTurns {
  private readonly pending = new Set<string>();
  constructor(
    private readonly runtimes: RuntimeStore,
    private readonly connections: RuntimeConnections,
    private readonly reconciler: RuntimeReconciler,
    private readonly operations: ProgrammeTurnStore,
  ) {}

  inspect(reference: string) {
    const owner = this.runtimes.get(reference) ?? this.runtimes.ownerOf(reference);
    if (!owner) return null;
    const client = this.connections.get(owner.runtime_id);
    if (
      owner.state !== 'running' ||
      !client?.state?.agent ||
      this.reconciler.pendingIds().includes(owner.runtime_id)
    )
      throw ApiError.conflict('agent_not_live', 'The agent runtime is not yet reconciled');
    if (client.state.agent.native_sync !== 'full')
      throw ApiError.conflict(
        'scripted_turns_unavailable',
        'This runtime has no supported automated-turn channel',
      );
    return {
      handle: { runtime_id: owner.runtime_id, session_id: owner.active_session_id },
      ready: client.state.agent.control_ready && !this.pending.has(owner.runtime_id),
    };
  }

  private target(reference: string): Target {
    const current = this.inspect(reference);
    if (!current) throw ApiError.conflict('agent_not_live', 'The agent has no independent runtime');
    const bound = this.runtimes.placementBinding(current.handle.runtime_id);
    const client = this.connections.get(current.handle.runtime_id)!;
    if (
      client.state?.binding?.session_id !== bound.session_id ||
      client.state.binding.segment_id !== bound.segment_id
    )
      throw ApiError.conflict(
        'runtime_reconciliation_required',
        'The runtime placement is not bound',
      );
    return {
      id: current.handle.runtime_id,
      placement: { session_id: bound.session_id, segment_id: bound.segment_id },
      client,
    };
  }

  ask(
    reference: string,
    scope: ProgrammeOperation,
    prompt: string,
    signal: AbortSignal,
    schema?: Record<string, unknown>,
    preserveOnAbort: () => boolean = () => false,
    dispatched: () => void = () => {},
  ): Promise<string> {
    // Existing programmes retain their own run authority and consumption policy.
    return this.askFor(
      reference,
      {
        check: (id) => this.operations.check(scope, id),
        reserve: (...args) => this.operations.reserve(scope, ...args),
        read: (id, turn) => this.operations.consume(scope, id, turn),
        checkCancellation: (id) => this.operations.check(scope, id),
        releaseUnused: (...args) => this.operations.releaseUnused(scope, ...args),
      },
      prompt,
      signal,
      schema,
      preserveOnAbort,
      dispatched,
    );
  }

  /** Cancel only the retained placement/turn after consuming caller-owned intent. */
  async cancelFor(
    reference: string,
    caller: RuntimeTurnCaller,
    placement: RuntimePlacement,
    turn: number,
    claim: () => boolean,
  ) {
    const current = this.target(reference);
    caller.checkCancellation(current.id, turn);
    if (
      current.placement.session_id !== placement.session_id ||
      current.placement.segment_id !== placement.segment_id
    )
      throw new Error('Agent placement changed before cancellation');
    // Consume durable cancellation intent immediately before its one exact send.
    if (claim()) await current.client.request({ t: 'cancel-turn', placement, turn });
  }

  /** All callers share one busy gate and the existing exact-turn provider channel. */
  async askFor(
    reference: string,
    caller: RuntimeTurnCaller,
    prompt: string,
    signal: AbortSignal,
    schema?: Record<string, unknown>,
    preserveOnAbort: () => boolean = () => false,
    dispatched: () => void = () => {},
  ): Promise<string> {
    signal.throwIfAborted();
    const target = this.target(reference);
    if (this.pending.has(target.id))
      throw ApiError.conflict('runtime_busy', 'The runtime already has a pending programme turn');
    this.pending.add(target.id);
    let turn: number | undefined;
    let expectedRef: string | null = null;
    let sent = false;
    let rejected = false;
    try {
      caller.check(target.id);
      const inspected = await target.client.request({ t: 'inspect' });
      signal.throwIfAborted();
      const current = this.target(reference);
      if (
        current.id !== target.id ||
        current.client !== target.client ||
        current.placement.session_id !== target.placement.session_id ||
        current.placement.segment_id !== target.placement.segment_id
      )
        throw new Error('Runtime changed before programme dispatch');
      if (inspected.t !== 'state' || !inspected.state.agent?.control_ready)
        throw ApiError.conflict('runtime_busy', 'Agent is not ready for an automated turn');
      expectedRef = inspected.state.agent.agent_session_ref;
      const origin =
        inspected.state.protocol.major === 1 && inspected.state.protocol.minor >= 2
          ? caller.origin?.()
          : undefined;
      // Validate provider input before durable capacity admission. These local
      // identity placeholders are never sent or persisted; the real ordered
      // turn/command identities are allocated below and by RuntimeClient.
      runtimeRequestSchema.parse({
        t: 'start-turn',
        id: target.id,
        sequence: 1,
        turn: 1,
        placement: target.placement,
        expected_ref: expectedRef,
        prompt,
        ...(schema ? { output_schema: schema } : {}),
        ...(origin ? { origin } : {}),
      });
      turn = caller.reserve(
        target.id,
        target.placement,
        expectedRef,
        inspected.state.turn?.turn ?? 0,
      );
      // No await between the durable intent, authority check and the single dispatch.
      caller.check(target.id);
      signal.throwIfAborted();
      sent = true;
      let uncertain = false;
      try {
        await target.client.request({
          t: 'start-turn',
          placement: target.placement,
          turn,
          expected_ref: expectedRef,
          prompt,
          ...(schema ? { output_schema: schema } : {}),
          ...(origin ? { origin } : {}),
        });
      } catch (error) {
        // These correlated errors occur before RuntimeTurns admits provider work.
        // Generic failures and duplicate identities can follow accepted work.
        rejected =
          error instanceof RuntimeRequestRejected &&
          error.request === 'start-turn' &&
          ['busy', 'fenced', 'stale_placement', 'invalid_request'].includes(error.code);
        if (!(error instanceof RuntimeConnectionLost)) throw error;
        uncertain = true; // Observe this identity; never resend its prompt.
      }
      // The prompt has been sent once. Its result can outlive daemon admission.
      dispatched();
      const discoveryDeadline = Date.now() + 15_000;
      for (;;) {
        signal.throwIfAborted();
        // Observing admitted work may remain authorised after fresh dispatch is revoked.
        const result = caller.read(target.id, turn);
        if (result && result.status !== 'running') {
          if (result.status === 'completed') return result.reply!;
          throw new Error(result.error ?? `Agent turn ${result.status}`);
        }
        if (!result && uncertain && Date.now() >= discoveryDeadline)
          throw ApiError.conflict(
            'runtime_outcome_unknown',
            'Turn admission is unknown; its prompt was not replayed',
          );
        if (!['prepared', 'running'].includes(this.runtimes.get(target.id)?.state ?? ''))
          throw new Error('Runtime ended without a committed turn outcome');
        await delay(100, undefined, { signal });
      }
    } finally {
      if (turn !== undefined && (!sent || rejected)) {
        try {
          caller.releaseUnused(target.id, target.placement, expectedRef, turn);
        } catch {
          // Lost storage access retains conservative debt; never replay the request.
        }
      }
      if (sent && !rejected && turn !== undefined && signal.aborted && !preserveOnAbort()) {
        // Cancellation addresses only the admitted identity and original placement.
        // A stale/lost cancellation is never retargeted or retried.
        try {
          caller.checkCancellation(target.id, turn);
          const current = this.target(reference);
          if (
            current.id === target.id &&
            current.placement.session_id === target.placement.session_id &&
            current.placement.segment_id === target.placement.segment_id
          )
            await current.client.request({ t: 'cancel-turn', placement: target.placement, turn });
        } catch {
          /* The accepted turn remains observable; no implicit input replay. */
        }
      }
      this.pending.delete(target.id);
    }
  }
}
