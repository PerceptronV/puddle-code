import { setTimeout as delay } from 'node:timers/promises';
import {
  canonicalHuddleJson,
  huddleSpawnScopeSchema,
  type HuddleSpawnScope,
  type HuddleSpawnRequest,
  type HuddleSpawnOutcome,
  type RuntimeIdentity,
} from '@puddle/shared';
import type { SessionService } from '../../../sessions/service.js';
import type { AdapterRegistry } from '../../../agents/registry.js';
import type { RuntimeStore } from '../../../db/stores/runtimes.js';
import type { RuntimeProgrammeTurns } from '../../../runtime/controller/programme-turns.js';
import type { RuntimeConnections } from '../../../runtime/transport/connections.js';
import { runtimeBindingIdentity } from '../../../runtime/transport/connections.js';
import type { RuntimeControls } from '../../../runtime/controller/controls.js';
import { ApiError } from '../../../http/errors.js';
import { HuddleSpawnStore, type HuddleSpawnAuthority } from './store.js';

interface Pending {
  intent: string;
  abort: AbortController;
}

/** Host-side creation/readiness and exact cleanup; the owner mailbox grants dispatch once. */
export class HuddleAgentSpawns {
  private readonly pending = new Map<string, Pending>();
  constructor(
    private readonly deps: {
      store: HuddleSpawnStore;
      service: Pick<SessionService, 'create'>;
      adapters: Pick<AdapterRegistry, 'get'>;
      runtimes: RuntimeStore;
      turns: Pick<RuntimeProgrammeTurns, 'inspect'>;
      connections: Pick<RuntimeConnections, 'get'>;
      controls: Pick<RuntimeControls, 'stop'>;
    },
    private readonly readyTimeoutMs = 120_000,
  ) {
    if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1 || readyTimeoutMs > 120_000)
      throw new Error('Invalid huddle spawn readiness deadline');
  }

  /** Only a fresh owner claim may call this. Reconnect calls observe, never spawn. */
  async spawn(
    inputScope: HuddleSpawnScope,
    request: HuddleSpawnRequest,
    signal: AbortSignal,
    authorised: HuddleSpawnAuthority,
  ): Promise<HuddleSpawnOutcome> {
    signal.throwIfAborted();
    const scope = huddleSpawnScopeSchema.parse(inputScope);
    const abort = new AbortController();
    const currentSignal = AbortSignal.any([signal, abort.signal]);
    const authority: HuddleSpawnAuthority = (mode) =>
      (mode === 'observe' || !currentSignal.aborted) && authorised(mode);
    const bound = this.deps.store.bind(scope, request, authority);
    const key = this.key(scope);
    if (this.pending.size >= 64) throw new Error('Huddle spawn dispatch queue is full');
    if (this.pending.has(key) || bound.observe())
      throw new Error(
        'Huddle spawn was already admitted; observe it without creating another agent',
      );
    bound.caller.check();
    if (!this.deps.adapters.get(bound.request.agent).scriptedTurns)
      throw new Error('Selected provider does not support exact huddle turns');
    this.pending.set(key, { intent: bound.caller.identity, abort });
    try {
      const value = bound.request;
      await this.deps.service.create(
        {
          project_id: value.projectId,
          account_id: value.accountId,
          join_worktree: value.worktree,
          separate_branch: false,
          separate_worktree: false,
          title: value.title,
        },
        value.mode,
        undefined,
        bound.caller,
      );
      const deadline = Date.now() + this.readyTimeoutMs;
      for (;;) {
        currentSignal.throwIfAborted();
        bound.caller.check();
        const result = this.observe(scope, value, authority);
        if (result) return result;
        const runtime = bound.observe()?.runtime;
        if (runtime && !['prepared', 'running'].includes(this.exact(runtime).state))
          throw new Error('Spawned agent ended before exact readiness was observed');
        if (Date.now() >= deadline)
          throw new Error('Spawned agent did not become ready; inspect its retained runtime');
        await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, {
          signal: currentSignal,
        });
      }
    } finally {
      // Controller loss/maintenance does not itself authorise stopping an accepted owner.
      this.pending.delete(key);
    }
  }

  /** Retain readiness before returning it. This method never launches or stops anything. */
  observe(scope: HuddleSpawnScope, request: HuddleSpawnRequest, authorised: HuddleSpawnAuthority) {
    const bound = this.deps.store.bind(scope, request, authorised);
    const retained = bound.outcome();
    if (retained) return retained;
    const admitted = bound.observe();
    if (!admitted?.runtime || admitted.stopRequested) return null;
    const identity = admitted.runtime;
    const owner = this.exact(identity);
    if (
      owner.state !== 'running' ||
      owner.active_session_id !== admitted.sessionId ||
      this.deps.runtimes.stopRequested(identity.runtime_id)
    )
      return null;
    const client = this.deps.connections.get(identity.runtime_id);
    if (
      !client?.state ||
      canonicalHuddleJson(client.state.identity) !== canonicalHuddleJson(identity) ||
      client.state.binding?.session_id !== admitted.sessionId ||
      client.state.binding.segment_id !== owner.active_segment_id
    )
      return null;
    try {
      const current = this.deps.turns.inspect(identity.runtime_id);
      if (
        !current?.ready ||
        current.handle.runtime_id !== identity.runtime_id ||
        current.handle.session_id !== admitted.sessionId
      )
        return null;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'agent_not_live') return null;
      throw error;
    }
    return bound.ready(identity);
  }

  /** Fence creation first; one queued exact-owner stop attempt, then observation only. */
  async cancel(
    scope: HuddleSpawnScope,
    request: HuddleSpawnRequest,
    authorised: HuddleSpawnAuthority,
  ) {
    const bound = this.deps.store.bind(scope, request, authorised);
    const admitted = bound.observe(); // Require current private observation authority before cancellation.
    const pending = this.pending.get(this.key(scope));
    if (pending) {
      if (pending.intent !== bound.caller.identity)
        throw new Error('Pending huddle spawn intent changed');
      pending.abort.abort(new Error('Huddle spawn cancelled'));
    }
    if (!admitted) return { state: pending ? ('pending' as const) : ('unadmitted' as const) };
    bound.requestStop();
    if (!admitted.runtime) return { state: 'unlaunched' as const };
    const identity = admitted.runtime;
    const owner = this.exact(identity);
    if (owner.state === 'exited') return { state: 'stopped' as const };
    if (!['prepared', 'running'].includes(owner.state))
      throw new Error('Spawned runtime cleanup is unconfirmed');
    const sessionId = owner.active_session_id;
    await this.deps.controls.stop(
      sessionId,
      () => {
        try {
          if (!authorised('observe')) return false;
          const current = bound.observe();
          return (
            !!current?.stopRequested &&
            current.runtime?.runtime_id === identity.runtime_id &&
            this.exact(identity).active_session_id === sessionId &&
            this.deps.runtimes.ownerOf(sessionId)?.runtime_id === identity.runtime_id
          );
        } catch {
          return false;
        }
      },
      () => bound.claimStop(),
    );
    bound.observe(); // Recheck private authority after the asynchronous stop observation.
    if (this.exact(identity).state !== 'exited')
      throw new Error('Spawned runtime clean shutdown is not confirmed');
    return { state: 'stopped' as const };
  }

  private exact(identity: RuntimeIdentity) {
    const owner = this.deps.runtimes.get(identity.runtime_id);
    if (
      !owner ||
      owner.role !== 'session' ||
      canonicalHuddleJson(runtimeBindingIdentity(owner)) !== canonicalHuddleJson(identity)
    )
      throw new Error('Spawned runtime identity changed');
    return owner;
  }
  private key(scope: HuddleSpawnScope) {
    return scope.owner.runtime_id + ':' + scope.operationId;
  }
}
