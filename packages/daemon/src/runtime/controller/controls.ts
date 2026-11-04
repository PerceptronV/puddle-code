import { RUNTIME_LIMITS, type RuntimeCommand, type RuntimePlacement } from '@puddle/shared';
import type { RuntimeStore } from '../../db/stores/runtimes.js';
import { HostAdmission } from '../../host/lifecycle/admission.js';
import { ApiError } from '../../http/errors.js';
import { RuntimeConnectionLost, type RuntimeClient } from '../transport/client.js';
import type { RuntimeConnections } from '../transport/connections.js';
import type { RuntimeReconciler } from './reconcile.js';

interface Target {
  id: string;
  placement: RuntimePlacement;
  client: RuntimeClient;
}
type Authorised = () => boolean;
const unavailable = () =>
  ApiError.conflict(
    'runtime_reconciliation_required',
    'The runtime changed or is unavailable; its work has not been replayed.',
  );

/** Serial host controls; the caller's placement is captured before any asynchronous wait. */
export class RuntimeControls {
  private readonly queues = new Map<string, { tail: Promise<unknown>; count: number }>();
  private closed = false;
  private readonly admission = new HostAdmission();
  constructor(
    private readonly runtimes: RuntimeStore,
    private readonly connections: RuntimeConnections,
    private readonly reconciler: RuntimeReconciler,
  ) {}

  private target(sessionId: string): Target {
    const owner = this.runtimes.ownerOf(sessionId);
    if (!owner || owner.active_session_id !== sessionId) throw unavailable();
    const client = this.connections.get(owner.runtime_id);
    const bound = this.runtimes.placementBinding(owner.runtime_id);
    const placement = { session_id: bound.session_id, segment_id: bound.segment_id };
    if (
      !client ||
      client.state?.binding?.session_id !== sessionId ||
      client.state.binding.segment_id !== placement.segment_id
    )
      throw unavailable();
    return { id: owner.runtime_id, placement, client };
  }

  private check(target: Target, authorised: Authorised): void {
    if (this.closed || !authorised())
      throw new ApiError(401, 'upstream_expired', 'Connection authority expired');
    const current = this.runtimes.get(target.id);
    if (
      current?.active_session_id !== target.placement.session_id ||
      current.active_segment_id !== target.placement.segment_id ||
      this.connections.get(target.id) !== target.client ||
      !['prepared', 'running'].includes(current.state)
    )
      throw unavailable();
  }

  private run<T>(
    sessionId: string,
    authorised: Authorised,
    action: (target: Target) => Promise<T>,
  ): Promise<T> {
    return this.admission.run(async () => {
      const target = this.target(sessionId);
      let queue = this.queues.get(target.id);
      if (!queue) {
        queue = { tail: Promise.resolve(), count: 0 };
        this.queues.set(target.id, queue);
      }
      if (queue.count >= RUNTIME_LIMITS.pendingRequests)
        throw ApiError.conflict('runtime_busy', 'Too many pending runtime controls');
      queue.count++;
      const entry = queue;
      const pending = queue.tail
        .then(async () => {
          this.check(target, authorised);
          return action(target);
        })
        .catch((error: unknown) => {
          if (error instanceof RuntimeConnectionLost)
            throw ApiError.conflict(
              'runtime_outcome_unknown',
              'The runtime control response was lost. Reconnect to inspect its outcome; the command was not replayed.',
            );
          throw error;
        });
      queue.tail = pending
        .catch(() => {})
        .finally(() => {
          entry.count--;
          if (entry.count === 0) this.queues.delete(target.id);
        });
      return pending;
    });
  }

  private async observe(id: string, through: number): Promise<void> {
    for (let pass = 0; pass < 4; pass++) {
      if ((this.runtimes.get(id)?.event_cursor ?? -1) >= through) return;
      await this.reconciler.refresh(id);
      if (this.reconciler.pendingIds().includes(id)) break;
    }
    if ((this.runtimes.get(id)?.event_cursor ?? -1) >= through) return;
    throw ApiError.conflict(
      'runtime_persistence_pending',
      'The runtime command was accepted; its saved state is pending. Reconnect to inspect it before trying again.',
    );
  }

  async spawnShell(
    sessionId: string,
    command: RuntimeCommand,
    captureEnabled: () => boolean,
    authorised: Authorised,
  ): Promise<string> {
    return this.run(sessionId, authorised, async (target) => {
      // Read owner inventory, not a possibly lagging application observation.
      const inspected = await target.client.request({ t: 'inspect' });
      if (inspected.t !== 'state') throw unavailable();
      const enabled = captureEnabled();
      if (inspected.state.environment.enabled !== enabled) {
        this.check(target, authorised);
        await target.client.request({ t: 'capture-env', placement: target.placement, enabled });
      }
      const used = new Set(inspected.state.terminals.map((term) => term.term));
      let n = 1;
      while (used.has(`shell-${n}`)) n++;
      const term = `shell-${n}`;
      this.check(target, authorised);
      await target.client.request({ t: 'spawn-shell', placement: target.placement, term, command });
      const state = await target.client.request({ t: 'inspect' });
      if (state.t !== 'state') throw unavailable();
      await this.observe(target.id, state.state.journal.cursor);
      if (!this.runtimes.terminalForPlacement(sessionId, term))
        throw ApiError.conflict(
          'runtime_persistence_pending',
          'The shell was started but its saved state is pending; reconnect to inspect it before starting another.',
        );
      return term;
    });
  }

  async clearEnvironment(sessionId: string, authorised: Authorised): Promise<number> {
    return this.run(sessionId, authorised, async (target) => {
      const response = await target.client.request({ t: 'clear-env', placement: target.placement });
      if (response.t !== 'env-cleared') throw unavailable();
      await this.observe(target.id, response.through);
      if (this.reconciler.pendingIds().includes(target.id))
        throw ApiError.conflict(
          'runtime_persistence_pending',
          'Captured environment was cleared in the runtime; its saved state is pending.',
        );
      return response.cleared;
    });
  }

  async stop(sessionId: string, authorised: Authorised): Promise<void> {
    await this.run(sessionId, authorised, async (target) => {
      this.runtimes.requestStop(
        target.id,
        target.placement.session_id,
        target.placement.segment_id,
      );
      try {
        await target.client.request({ t: 'stop', placement: target.placement });
      } catch (error) {
        if (!(error instanceof RuntimeConnectionLost)) throw error;
        // A lost acknowledgement is observed, never retransmitted.
      }
      const deadline = Date.now() + 15_000;
      while (!this.closed) {
        const current = this.runtimes.get(target.id);
        if (current?.state === 'exited') return;
        if (
          !current ||
          current.state === 'failed' ||
          current.state === 'interrupted' ||
          Date.now() >= deadline
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw ApiError.conflict(
        'runtime_stop_unconfirmed',
        'The stop request is recorded, but clean runtime shutdown is not confirmed. Inspect the runtime before cleanup.',
      );
    });
  }

  pause(): ReturnType<HostAdmission['pause']> {
    return this.admission.pause();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.admission.close();
    await this.admission.drain();
  }
}
