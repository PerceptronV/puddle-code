import { realpathSync } from 'node:fs';
import {
  canonicalHuddleJson,
  huddleLifecycleRequestSchema,
  huddleSpawnScopeSchema,
  huddleSpawnOutcomeSchema,
  type HuddleLifecycleRequest,
  type HuddleSpawnScope,
  type HuddleSpawnOutcome,
  type RuntimeIdentity,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import type { Db } from '../../../db/db.js';
import type { SessionStore } from '../../../db/stores/sessions.js';
import type { RuntimeStore } from '../../../db/stores/runtimes.js';
import type { SessionService } from '../../../sessions/service.js';
import type { SessionLaunchCaller } from '../../../sessions/creation/caller.js';
import type { RuntimeProgrammeTurns } from '../../../runtime/controller/programme-turns.js';
import type { AdapterRegistry } from '../../../agents/registry.js';
import type { HuddleSpawnAuthority } from '../spawns/store.js';
import { requireHuddleOwnerScope } from '../authority.js';
import { huddleLifecycleReceipt } from './receipt.js';

interface Mapping {
  intent: string;
  runtime_id: string | null;
  outcome: string | null;
}

/** Lifecycle mechanics remain in SessionService. This adapter only attributes one durable attempt. */
export class HuddleAgentLifecycle {
  constructor(
    private readonly deps: {
      db: Db;
      sessions: Pick<SessionStore, 'get'>;
      runtimes: Pick<RuntimeStore, 'get' | 'ownerOf' | 'stopRequested'>;
      service: Pick<SessionService, 'resumeForCaller' | 'inspectRuntime' | 'restartRuntime'>;
      turns: Pick<RuntimeProgrammeTurns, 'inspect'>;
      adapters: Pick<AdapterRegistry, 'get'>;
    },
  ) {}

  private bind(
    rawScope: HuddleSpawnScope,
    rawRequest: HuddleLifecycleRequest,
    authorised: HuddleSpawnAuthority,
  ) {
    const scope = huddleSpawnScopeSchema.parse(rawScope);
    const request = huddleLifecycleRequestSchema.parse(rawRequest);
    const target = request.target;
    const intent = canonicalHuddleJson({ scope, request });
    const authority = (dispatch: boolean) => {
      if (!authorised(dispatch ? 'dispatch' : 'observe'))
        throw new Error('Huddle lifecycle authority expired');
      requireHuddleOwnerScope(this.deps.db, scope.owner, dispatch);
      if (target.projectId !== scope.owner.project_id)
        throw new Error('Lifecycle target belongs to another project');
    };
    const mapping = (): Mapping | undefined => {
      const row = this.deps.db
        .prepare(
          'SELECT intent, runtime_id, outcome FROM huddle_session_operations WHERE owner_runtime_id = ? AND operation_id = ?',
        )
        .get(scope.owner.runtime_id, scope.operationId) as Mapping | undefined;
      if (row && row.intent !== intent) throw new Error('Retained lifecycle intent changed');
      return row;
    };
    const placement = () => {
      const session = this.deps.sessions.get(target.sessionId);
      if (
        session.kind !== 'agent' ||
        session.project_id !== target.projectId ||
        session.account_id !== target.accountId ||
        session.agent_type !== target.agent ||
        session.agent_mode !== target.mode ||
        session.agent_session_ref !== target.nativeRef ||
        session.status === 'archived' ||
        realpathSync(session.worktree_path) !== target.worktree
      )
        throw new Error('Lifecycle target changed since activation');
      return session;
    };
    const check = () => {
      authority(true);
      const session = placement();
      const owner = this.deps.runtimes.ownerOf(target.sessionId);
      if (
        owner &&
        (!target.runtime ||
          owner.runtime_id !== target.runtime.runtimeId ||
          owner.incarnation !== target.runtime.incarnation ||
          owner.active_session_id !== target.sessionId)
      )
        throw new Error('Lifecycle target has a different runtime');
      if (
        request.action === 'resume' &&
        (owner || !['exited', 'interrupted'].includes(session.status))
      )
        throw new Error('Only stopped agent sessions can resume');
      if (request.action === 'restart' && !target.runtime)
        throw new Error('Restart requires a captured runtime');
      if (mapping()?.runtime_id)
        throw new Error('Lifecycle replacement already prepared; observe it');
    };
    const caller: SessionLaunchCaller = {
      identity: digest(intent),
      check,
      bind: (identity: RuntimeIdentity) => {
        authority(true);
        placement();
        const row = mapping();
        const owner = this.deps.runtimes.get(identity.runtime_id);
        if (
          !row ||
          row.runtime_id ||
          identity.session_id !== target.sessionId ||
          identity.profile_id !== scope.owner.profile_id ||
          identity.project_id !== target.projectId ||
          identity.canonical_worktree_path !== target.worktree ||
          !owner ||
          owner.state !== 'prepared' ||
          owner.incarnation !== identity.incarnation ||
          owner.launch_id !== identity.launch_id ||
          owner.active_session_id !== target.sessionId ||
          owner.account_id !== target.accountId ||
          owner.agent_type !== target.agent
        )
          throw new Error('Replacement runtime differs from lifecycle intent');
        this.deps.db
          .prepare(
            'UPDATE huddle_session_operations SET runtime_id = ? WHERE owner_runtime_id = ? AND operation_id = ?',
          )
          .run(identity.runtime_id, scope.owner.runtime_id, scope.operationId);
      },
    };
    return { scope, request, target, intent, authority, mapping, placement, check, caller };
  }

  /** Only a freshly consumed owner claim may enter. A retained attempt is never dispatched again. */
  async execute(
    scope: HuddleSpawnScope,
    request: HuddleLifecycleRequest,
    authorised: HuddleSpawnAuthority,
  ) {
    const bound = this.bind(scope, request, authorised);
    bound.check();
    if (!this.deps.adapters.get(bound.target.agent).scriptedTurns)
      throw new Error('Selected provider does not support exact huddle turns');
    let fingerprint: string | undefined;
    let reviewRecord: string | null = null;
    if (request.action === 'restart') {
      const review = await this.deps.service.inspectRuntime(bound.target.sessionId, () => {
        try {
          bound.check();
          return true;
        } catch {
          return false;
        }
      });
      bound.check();
      if (!review.restart.available) throw new Error('Selected runtime cannot currently restart');
      fingerprint = review.restart.fingerprint;
      reviewRecord = JSON.stringify(review);
    }
    this.deps.db.transaction(() => {
      bound.check();
      if (bound.mapping()) throw new Error('Lifecycle operation already attempted; observe it');
      const count = this.deps.db
        .prepare('SELECT COUNT(*) AS count FROM huddle_session_operations')
        .get() as { count: number };
      if (count.count >= 10_000) throw new Error('Huddle lifecycle retention is full');
      this.deps.db
        .prepare(
          `INSERT INTO huddle_session_operations(owner_runtime_id, operation_id, intent, review, session_id, previous_runtime_id)
          VALUES (?, ?, ?, ?, ?, (SELECT runtime_id FROM terminal_placements WHERE session_id = ?))`,
        )
        .run(
          bound.scope.owner.runtime_id,
          bound.scope.operationId,
          bound.intent,
          reviewRecord,
          bound.target.sessionId,
          bound.target.sessionId,
        );
    })();
    const check = () => {
      try {
        bound.check();
        return true;
      } catch {
        return false;
      }
    };
    if (bound.request.action === 'resume')
      await this.deps.service.resumeForCaller(bound.target.sessionId, bound.caller);
    else
      await this.deps.service.restartRuntime(
        bound.target.sessionId,
        { fingerprint: fingerprint! },
        check,
        bound.caller,
      );
  }

  observe(
    scope: HuddleSpawnScope,
    request: HuddleLifecycleRequest,
    authorised: HuddleSpawnAuthority,
  ): HuddleSpawnOutcome | null {
    const bound = this.bind(scope, request, authorised);
    bound.authority(false);
    const row = bound.mapping();
    if (row?.outcome) {
      const result = huddleSpawnOutcomeSchema.parse(JSON.parse(row.outcome));
      if (
        result.agent.runtimeId !== row.runtime_id ||
        result.agent.sessionId !== bound.target.sessionId ||
        result.receipt !== huddleLifecycleReceipt(bound.scope, bound.request, result.agent)
      )
        throw new Error('Retained lifecycle outcome changed');
      return result;
    }
    if (!row?.runtime_id) return null;
    const owner = this.deps.runtimes.get(row.runtime_id);
    if (
      !owner ||
      owner.role !== 'session' ||
      owner.state !== 'running' ||
      owner.profile_id !== bound.scope.owner.profile_id ||
      owner.active_session_id !== bound.target.sessionId ||
      owner.project_id !== bound.target.projectId ||
      owner.canonical_worktree_path !== bound.target.worktree ||
      this.deps.runtimes.stopRequested(owner.runtime_id)
    )
      return null;
    bound.placement();
    let current;
    try {
      current = this.deps.turns.inspect(owner.runtime_id);
    } catch {
      return null;
    }
    if (
      !current?.ready ||
      current.handle.runtime_id !== owner.runtime_id ||
      current.handle.session_id !== bound.target.sessionId
    )
      return null;
    bound.authority(false);
    const agent = {
      runtimeId: owner.runtime_id,
      incarnation: owner.incarnation,
      sessionId: bound.target.sessionId,
      projectId: bound.target.projectId,
      worktree: bound.target.worktree,
    };
    const outcome = huddleSpawnOutcomeSchema.parse({
      agent,
      receipt: huddleLifecycleReceipt(bound.scope, bound.request, agent),
    });
    this.deps.db
      .prepare(
        'UPDATE huddle_session_operations SET outcome = ? WHERE owner_runtime_id = ? AND operation_id = ?',
      )
      .run(JSON.stringify(outcome), bound.scope.owner.runtime_id, bound.scope.operationId);
    return outcome;
  }

  unused(
    scope: HuddleSpawnScope,
    request: HuddleLifecycleRequest,
    authorised: HuddleSpawnAuthority,
  ) {
    const bound = this.bind(scope, request, authorised);
    bound.authority(false);
    return !bound.mapping();
  }
}
