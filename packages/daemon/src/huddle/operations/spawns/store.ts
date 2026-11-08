import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  canonicalHuddleJson,
  huddleSpawnRequestSchema,
  huddleSpawnScopeSchema,
  runtimeIdentitySchema,
  type HuddleSpawnRequest,
  type HuddleSpawnScope,
  type RuntimeIdentity,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import type { Db } from '../../../db/db.js';
import type { SessionCreationCaller } from '../../../sessions/creation/caller.js';
import { requireHuddleOwnerScope } from '../authority.js';

export const HUDDLE_SPAWN_LIMITS = { execution: 32, owner: 1024, host: 10_000 } as const;
export type HuddleSpawnAuthority = (mode: 'dispatch' | 'observe') => boolean;
interface Mapping {
  intent: string;
  session_id: string;
  runtime_id: string | null;
  stop_requested: number;
}

/** Host-side spawn consumption. Missing/lost replies never authorise another creation. */
export class HuddleSpawnStore {
  constructor(
    private readonly db: Db,
    private readonly limits: Record<keyof typeof HUDDLE_SPAWN_LIMITS, number> = HUDDLE_SPAWN_LIMITS,
  ) {
    for (const key of ['execution', 'owner', 'host'] as const)
      if (
        !Number.isSafeInteger(limits[key]) ||
        limits[key] < 1 ||
        limits[key] > HUDDLE_SPAWN_LIMITS[key]
      )
        throw new Error('Invalid huddle spawn retention limit');
  }

  bind(input: HuddleSpawnScope, value: HuddleSpawnRequest, authorised: HuddleSpawnAuthority) {
    const scope = huddleSpawnScopeSchema.parse(input);
    const request = Object.freeze(huddleSpawnRequestSchema.parse(value));
    if (!isAbsolute(request.worktree) || request.projectId !== scope.owner.project_id)
      throw new Error('Huddle spawn requires an explicit worktree in its project');
    const intent = canonicalHuddleJson({ scope, request });
    const check = (mode: 'dispatch' | 'observe') => {
      if (!authorised(mode)) throw new Error('Huddle spawn authority expired');
      requireHuddleOwnerScope(this.db, scope.owner, mode === 'dispatch');
      if (mode === 'dispatch') {
        if (realpathSync(request.worktree) !== request.worktree)
          throw new Error('Huddle spawn worktree is no longer canonical');
        const account = this.db
          .prepare(
            `SELECT 1 FROM accounts a JOIN projects p ON p.id = ?
          WHERE a.id = ? AND a.profile_id = ? AND p.profile_id = a.profile_id
          AND a.agent_type = ? AND a.logged_in = 1 AND p.archived = 0`,
          )
          .get(request.projectId, request.accountId, scope.owner.profile_id, request.agent);
        if (!account) throw new Error('Huddle spawn account/project is no longer available');
      }
    };
    const mapping = () => {
      const row = this.db
        .prepare(
          `SELECT intent, session_id, runtime_id, stop_requested
        FROM huddle_runtime_spawns WHERE owner_runtime_id = ? AND operation_id = ?`,
        )
        .get(scope.owner.runtime_id, scope.operationId) as Mapping | undefined;
      if (row && row.intent !== intent) throw new Error('Huddle spawn intent changed');
      return row;
    };
    const requireMapping = () => {
      const row = mapping();
      if (!row) throw new Error('No admitted huddle spawn');
      return row;
    };
    const sessionMatches = (sessionId: string) =>
      this.db
        .prepare(
          `SELECT 1 FROM sessions
      WHERE id = ? AND kind = 'agent' AND project_id = ? AND account_id = ?
      AND agent_type = ? AND agent_mode = ? AND canonical_worktree_path = ? AND status != 'archived'`,
        )
        .get(
          sessionId,
          request.projectId,
          request.accountId,
          request.agent,
          request.mode,
          request.worktree,
        );
    const caller: SessionCreationCaller = {
      identity: digest(intent),
      check: () => check('dispatch'),
      record: (sessionId) => {
        check('dispatch');
        if (mapping()) throw new Error('Huddle spawn already created a placement; observe it');
        if (!sessionMatches(sessionId))
          throw new Error('Created agent differs from huddle spawn intent');
        const counts = this.db
          .prepare(
            `SELECT COUNT(*) AS host,
          COALESCE(SUM(owner_runtime_id = ?), 0) AS owner,
          COALESCE(SUM(owner_runtime_id = ? AND execution_id = ?), 0) AS execution
          FROM huddle_runtime_spawns`,
          )
          .get(scope.owner.runtime_id, scope.owner.runtime_id, scope.executionId) as Record<
          keyof typeof HUDDLE_SPAWN_LIMITS,
          number
        >;
        if (
          (['host', 'owner', 'execution'] as const).some((key) => counts[key] >= this.limits[key])
        )
          throw new Error('Huddle spawn binding retention is full');
        this.db
          .prepare(
            `INSERT INTO huddle_runtime_spawns
          (owner_runtime_id, operation_id, execution_id, invocation_id, intent, session_id)
          VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            scope.owner.runtime_id,
            scope.operationId,
            scope.executionId,
            scope.invocationId,
            intent,
            sessionId,
          );
      },
      bind: (inputIdentity) => {
        check('dispatch');
        const identity = runtimeIdentitySchema.parse(inputIdentity);
        const row = requireMapping();
        if (row.runtime_id || row.stop_requested)
          throw new Error('Huddle spawn was cancelled or already dispatched');
        if (
          identity.session_id !== row.session_id ||
          identity.project_id !== request.projectId ||
          identity.profile_id !== scope.owner.profile_id ||
          identity.canonical_worktree_path !== request.worktree ||
          !sessionMatches(row.session_id)
        )
          throw new Error('Huddle spawn runtime differs from its placement');
        const admitted = this.db
          .prepare(
            `SELECT 1 FROM runtime_bindings WHERE runtime_id = ?
          AND incarnation = ? AND launch_id = ? AND launch_session_id = ? AND active_session_id = ?
          AND role = 'session' AND state = 'prepared' AND profile_id = ? AND project_id = ?
          AND canonical_worktree_path = ? AND account_id = ? AND agent_type = ?`,
          )
          .get(
            identity.runtime_id,
            identity.incarnation,
            identity.launch_id,
            row.session_id,
            row.session_id,
            identity.profile_id,
            identity.project_id,
            identity.canonical_worktree_path,
            request.accountId,
            request.agent,
          );
        if (!admitted) throw new Error('Huddle spawn has no exact prepared runtime');
        this.db
          .prepare(
            `UPDATE huddle_runtime_spawns SET runtime_id = ?
          WHERE owner_runtime_id = ? AND operation_id = ? AND runtime_id IS NULL AND stop_requested = 0`,
          )
          .run(identity.runtime_id, scope.owner.runtime_id, scope.operationId);
      },
    };
    return {
      caller,
      request,
      observe: () => {
        check('observe');
        const row = mapping();
        if (!row) return null;
        let runtime: RuntimeIdentity | null = null;
        if (row.runtime_id) {
          const bound = this.db
            .prepare(
              `SELECT runtime_id, incarnation, launch_id, profile_id, project_id,
            launch_session_id AS session_id, canonical_worktree_path FROM runtime_bindings WHERE runtime_id = ?`,
            )
            .get(row.runtime_id);
          runtime = runtimeIdentitySchema.parse(bound);
          if (
            runtime.session_id !== row.session_id ||
            runtime.profile_id !== scope.owner.profile_id ||
            runtime.project_id !== request.projectId ||
            runtime.canonical_worktree_path !== request.worktree
          )
            throw new Error('Retained huddle spawn runtime changed');
        }
        return { sessionId: row.session_id, runtime, stopRequested: !!row.stop_requested };
      },
      requestStop: () =>
        this.db.transaction(() => {
          check('observe');
          requireMapping();
          this.db
            .prepare(
              `UPDATE huddle_runtime_spawns SET stop_requested = 1
          WHERE owner_runtime_id = ? AND operation_id = ?`,
            )
            .run(scope.owner.runtime_id, scope.operationId);
        })(),
    };
  }
}
