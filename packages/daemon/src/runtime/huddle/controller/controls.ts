import {
  RUNTIME_LIMITS,
  type HuddleOwnerState,
  type HuddleActivationInput,
  type HuddleJson,
  type HuddleSessionFeedCursor,
} from '@puddle/shared';
import type { RuntimeStore } from '../../../db/stores/runtimes.js';
import { ApiError } from '../../../http/errors.js';
import { HostAdmission } from '../../../host/lifecycle/admission.js';
import type { RuntimeConnections } from '../../transport/connections.js';
import { RuntimeConnectionLost } from '../../transport/client.js';
import type { RuntimeReconciler } from '../../controller/reconcile.js';
import { HuddleOwnerRejected, type HuddleOwnerClient } from '../transport/client.js';
import {
  requireHuddleControl,
  type HuddleControlTarget,
  type HuddleOwnerTarget,
} from './observations.js';
import {
  huddleHistoryQuerySchema,
  readHuddleHistoryPage,
  type HuddleHistoryQuery,
} from './history.js';

interface Target {
  id: string;
  incarnation: string;
  sessionId: string;
  client: HuddleOwnerClient;
}
type Authorised = () => boolean;
const unavailable = () =>
  ApiError.conflict(
    'huddle_unavailable',
    'Huddle ownership changed or is unavailable; inspect it before another command',
  );

/** Exact-owner controls; queueing never transfers a command to a replacement owner. */
export class HuddleRuntimeControls {
  private readonly admission = new HostAdmission();
  private readonly queues = new Map<string, { tail: Promise<unknown>; count: number }>();
  private closed = false;
  constructor(
    private readonly runtimes: RuntimeStore,
    private readonly connections: RuntimeConnections,
    private readonly reconciler: RuntimeReconciler,
    private readonly feedBaseline?: () => HuddleSessionFeedCursor,
  ) {}

  private check(target: Target, authorised: Authorised) {
    if (this.closed || !authorised())
      throw new ApiError(401, 'upstream_expired', 'Connection authority expired');
    const binding = this.runtimes.ownerOf(target.sessionId);
    if (
      binding?.role !== 'huddle' ||
      binding.runtime_id !== target.id ||
      binding.incarnation !== target.incarnation ||
      this.connections.getHuddle(target.id) !== target.client
    )
      throw unavailable();
  }
  private run<T>(
    sessionId: string,
    authorised: Authorised,
    action: (target: Target) => Promise<T>,
    expected?: HuddleOwnerTarget,
  ): Promise<T> {
    return this.admission.run(async () => {
      const binding = this.runtimes.ownerOf(sessionId);
      if (binding?.role !== 'huddle') throw unavailable();
      if (
        expected &&
        (binding.runtime_id !== expected.runtimeId || binding.incarnation !== expected.incarnation)
      )
        throw unavailable();
      const client = this.connections.getHuddle(binding.runtime_id);
      if (!client) throw unavailable();
      const target = {
        id: binding.runtime_id,
        incarnation: binding.incarnation,
        sessionId,
        client,
      };
      this.check(target, authorised);
      let queue = this.queues.get(target.id);
      if (!queue) {
        queue = { tail: Promise.resolve(), count: 0 };
        this.queues.set(target.id, queue);
      }
      if (queue.count >= RUNTIME_LIMITS.pendingRequests)
        throw ApiError.conflict('huddle_busy', 'Too many pending huddle controls');
      queue.count++;
      const entry = queue;
      const pending = queue.tail
        .then(async () => {
          this.check(target, authorised);
          return action(target);
        })
        .catch((error: unknown) => {
          if (error instanceof HuddleOwnerRejected)
            throw ApiError.conflict(
              'huddle_command_rejected',
              'The owner refused the command; inspect its retained state before another mutation',
            );
          if (error instanceof RuntimeConnectionLost)
            throw ApiError.conflict(
              'huddle_outcome_unknown',
              'The huddle reply was lost. Inspect its retained outcome; the command was not replayed.',
            );
          throw error;
        });
      queue.tail = pending
        .catch(() => {})
        .finally(() => {
          if (--entry.count === 0) this.queues.delete(target.id);
        });
      return pending;
    });
  }
  private async observe(target: Target, state: HuddleOwnerState, authorised: Authorised) {
    this.check(target, authorised);
    for (let pass = 0; pass < 4; pass++) {
      if (
        (this.runtimes.get(target.id)?.event_cursor ?? -1) >= state.observation &&
        this.reconciler.settled(target.id)
      )
        return;
      await this.reconciler.refresh(target.id);
      this.check(target, authorised);
      if (this.reconciler.pendingIds().includes(target.id)) break;
    }
    if (
      (this.runtimes.get(target.id)?.event_cursor ?? -1) < state.observation ||
      !this.reconciler.settled(target.id)
    )
      throw ApiError.conflict(
        'huddle_persistence_pending',
        'The huddle command was accepted but its projection is pending; inspect it before another mutation',
      );
  }
  private async inspectTarget(target: Target, authorised: Authorised) {
    const response = await target.client.request({ t: 'inspect' });
    if (response.t !== 'state') throw unavailable();
    await this.observe(target, response.state, authorised);
    return response.state;
  }
  inspect(sessionId: string, authorised: Authorised) {
    return this.run(sessionId, authorised, (target) => this.inspectTarget(target, authorised));
  }
  records(
    sessionId: string,
    expected: HuddleOwnerTarget,
    input: HuddleHistoryQuery,
    authorised: Authorised,
  ) {
    const query = huddleHistoryQuerySchema.parse(input);
    return this.run(
      sessionId,
      authorised,
      async (target) => {
        const response = await target.client.request({ t: 'records', ...query });
        this.check(target, authorised);
        if (response.t !== 'records') throw unavailable();
        return {
          owner: { runtimeId: target.id, incarnation: target.incarnation },
          ...readHuddleHistoryPage(query, response.rows),
        };
      },
      { ...expected },
    );
  }
  private async review(target: Target, expected: HuddleControlTarget, authorised: Authorised) {
    requireHuddleControl(await this.inspectTarget(target, authorised), expected);
  }
  private requireDispatch(target: Target, authorised: Authorised) {
    // Recheck synchronously at dispatch after every awaited review.
    this.check(target, authorised);
    if (this.runtimes.stopRequested(target.id))
      throw ApiError.conflict('huddle_stopping', 'Stop has already been requested for this owner');
  }
  private mutate(
    sessionId: string,
    expected: HuddleControlTarget,
    request:
      | { t: 'arm'; expectedGeneration: number; autoStart: boolean }
      | { t: 'interrupt' }
      | { t: 'apply'; activation: HuddleActivationInput; expectedGeneration: number },
    authorised: Authorised,
  ) {
    const reviewed = { ...expected };
    return this.run(
      sessionId,
      authorised,
      async (target) => {
        await this.review(target, reviewed, authorised);
        this.requireDispatch(target, authorised);
        const feedBaseline =
          (request.t === 'arm' || request.t === 'apply') &&
          target.client.state?.capabilities.sessionEvents === 1 &&
          this.feedBaseline
            ? this.feedBaseline()
            : undefined;
        // Capture after queued review, immediately before the one exact lifecycle send.
        const response = await target.client.request({
          ...request,
          ...(feedBaseline ? { feedBaseline } : {}),
        });
        if (response.t !== 'state') throw unavailable();
        await this.observe(target, response.state, authorised);
        return response.state;
      },
      reviewed,
    );
  }
  arm(
    sessionId: string,
    expected: HuddleControlTarget,
    autoStart: boolean,
    authorised: Authorised,
  ) {
    return this.mutate(
      sessionId,
      expected,
      { t: 'arm', expectedGeneration: expected.generation, autoStart },
      authorised,
    );
  }
  apply(
    sessionId: string,
    activation: HuddleActivationInput,
    expected: HuddleControlTarget,
    authorised: Authorised,
  ) {
    return this.mutate(
      sessionId,
      expected,
      {
        t: 'apply',
        activation: structuredClone(activation),
        expectedGeneration: expected.generation,
      },
      authorised,
    );
  }
  interrupt(sessionId: string, expected: HuddleControlTarget, authorised: Authorised) {
    return this.mutate(sessionId, expected, { t: 'interrupt' }, authorised);
  }
  trigger(
    sessionId: string,
    expected: HuddleControlTarget,
    node: string,
    eventId: string,
    data: HuddleJson,
    authorised: Authorised,
  ) {
    const reviewed = { ...expected };
    const input = structuredClone(data);
    return this.run(
      sessionId,
      authorised,
      async (target) => {
        await this.review(target, reviewed, authorised);
        this.requireDispatch(target, authorised);
        const response = await target.client.request({ t: 'run', node, eventId, data: input });
        if (response.t !== 'run') throw unavailable();
        await this.inspectTarget(target, authorised);
        return { executionId: response.executionId, duplicate: response.duplicate };
      },
      reviewed,
    );
  }
  stop(
    sessionId: string,
    authorised: Authorised,
    review?: (state: HuddleOwnerState) => void,
  ): Promise<void> {
    return this.run(sessionId, authorised, async (target) => {
      if (review) review(await this.inspectTarget(target, authorised));
      this.check(target, authorised);
      if (this.runtimes.requestHuddleStop(target.id, target.sessionId)) {
        try {
          await target.client.request({ t: 'shutdown' });
        } catch (error) {
          if (!(error instanceof RuntimeConnectionLost)) throw error;
        }
      }
      const deadline = Date.now() + 15_000;
      while (!this.closed) {
        if (!authorised())
          throw new ApiError(401, 'upstream_expired', 'Connection authority expired');
        const current = this.runtimes.get(target.id);
        if (current?.state === 'exited') return;
        if (!current || ['failed', 'interrupted'].includes(current.state) || Date.now() >= deadline)
          break;
        await this.connections.connectOwner(target.id);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw ApiError.conflict(
        'huddle_stop_unconfirmed',
        'Stop is recorded but clean huddle shutdown is unconfirmed. Inspect it before cleanup; shutdown was not replayed.',
      );
    });
  }
  pause(): ReturnType<HostAdmission['pause']> {
    return this.admission.pause();
  }
  async close() {
    this.closed = true;
    this.admission.close();
    await this.admission.drain();
  }
}
