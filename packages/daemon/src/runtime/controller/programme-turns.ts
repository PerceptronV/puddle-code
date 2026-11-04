import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimePlacement } from '@puddle/shared';
import type { RuntimeStore } from '../../db/stores/runtimes.js';
import { ApiError } from '../../http/errors.js';
import { ProgrammeTurnStore, type ProgrammeOperation } from '../../puddlang/runtime-turn-store.js';
import { RuntimeConnectionLost, type RuntimeClient } from '../transport/client.js';
import type { RuntimeConnections } from '../transport/connections.js';
import type { RuntimeReconciler } from './reconcile.js';

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

  async ask(
    reference: string,
    scope: ProgrammeOperation,
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
    let sent = false;
    try {
      this.operations.check(scope, target.id);
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
      const expectedRef = inspected.state.agent.agent_session_ref;
      turn = this.operations.reserve(
        scope,
        target.id,
        target.placement,
        expectedRef,
        inspected.state.turn?.turn ?? 0,
      );
      // No await between the durable intent, authority check and the single dispatch.
      this.operations.check(scope, target.id);
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
        });
      } catch (error) {
        if (!(error instanceof RuntimeConnectionLost)) throw error;
        uncertain = true; // Observe this identity; never resend its prompt.
      }
      // The prompt has been sent once. Its result can outlive daemon admission.
      dispatched();
      const discoveryDeadline = Date.now() + 15_000;
      for (;;) {
        signal.throwIfAborted();
        this.operations.check(scope, target.id);
        const result = this.operations.consume(scope, target.id, turn);
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
      if (sent && turn !== undefined && signal.aborted && !preserveOnAbort()) {
        // Cancellation addresses only the admitted identity and original placement.
        // A stale/lost cancellation is never retargeted or retried.
        try {
          this.operations.check(scope, target.id);
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
