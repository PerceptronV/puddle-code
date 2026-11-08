import { realpathSync } from 'node:fs';
import { requireHuddleHostFeatures } from '../../runtime/huddle/triggers/definitions.js';
import { randomUUID } from 'node:crypto';
import {
  huddleStartSchema,
  huddleApplySchema,
  huddleRunSchema,
  huddleLifecycleCommandSchema,
  huddleHistoryRequestSchema,
  huddleExecutionViewSchema,
  huddleInvocationViewSchema,
  huddleOperationViewSchema,
  canonicalHuddleJson,
  type HuddleStart,
  type HuddleApply,
  type HuddleRun,
  type HuddleLifecycleCommand,
  type HuddleHistoryRequest,
  type HuddleRuntimeInspection,
  type Session,
} from '@puddle/shared';
import type { ProfileStore } from '../../db/stores/profiles.js';
import type { ProjectStore } from '../../db/stores/projects.js';
import type { SessionStore } from '../../db/stores/sessions.js';
import type { RuntimeStore } from '../../db/stores/runtimes.js';
import type { RuntimeLauncher } from '../../runtime/lifecycle/launcher.js';
import type { HuddleRuntimeControls } from '../../runtime/huddle/controller/controls.js';
import {
  huddleControlTarget,
  requireHuddleControl,
} from '../../runtime/huddle/controller/observations.js';
import { HuddleRevisionStore } from '../../runtime/huddle/state/revisions.js';
import { prepareHuddleActivation } from '../../runtime/huddle/control/revisions.js';
import type { StorageMonitor } from '../../storage/monitor.js';
import type { HuddleService } from '../control/service.js';
import { ApiError } from '../../http/errors.js';
import { huddleExecutionBindings } from './bindings.js';
import { huddleHostIdentity } from './host.js';
import { requireHuddleSource } from './source.js';

type Authority = () => boolean;
interface Dependencies {
  home: string;
  profiles: Pick<ProfileStore, 'get'>;
  projects: Pick<ProjectStore, 'get'>;
  sessions: Pick<SessionStore, 'get'>;
  runtimes: Pick<RuntimeStore, 'ownerOf' | 'hasUnreleasedHuddle' | 'stopRequested'>;
  definitions: HuddleService;
  controls: HuddleRuntimeControls;
  launcher?: Pick<RuntimeLauncher, 'launchHuddle' | 'checkHuddleAvailable'>;
  storage?: Pick<StorageMonitor, 'assertAdmission'>;
  agentBinding?: (profile: string, project: string, reference: string, worktree: string) => string;
}

/** Local/SSH placement authority surrounds every private owner operation. */
export class HuddleExecutionService {
  constructor(private readonly deps: Dependencies) {}

  private scope(profile: string, id: string, authority: Authority, admitting = false) {
    const check = () => {
      if (!authority()) throw new ApiError(401, 'upstream_expired', 'Connection authority expired');
      this.deps.profiles.get(profile);
      const session = this.deps.sessions.get(id);
      const project = this.deps.projects.get(session.project_id);
      if (project.profile_id !== profile)
        throw new ApiError(403, 'profile_scope', 'Huddle belongs to another profile');
      if (session.kind !== 'huddle' || !session.huddle_id)
        throw ApiError.badRequest('not_huddle', 'This placement is not a huddle');
      if (admitting && (session.status === 'archived' || project.archived))
        throw ApiError.conflict(
          'huddle_archived',
          'Unarchive the huddle and project before admitting work',
        );
      if (admitting) requireHuddleSource(session);
      return session;
    };
    const session = check();
    const valid = () => {
      try {
        const current = check();
        return (
          current.project_id === session.project_id &&
          current.huddle_id === session.huddle_id &&
          current.worktree_path === session.worktree_path
        );
      } catch {
        return false;
      }
    };
    return { session, check, valid };
  }

  async inspect(
    profile: string,
    id: string,
    authority: Authority,
  ): Promise<HuddleRuntimeInspection> {
    const scope = this.scope(profile, id, authority);
    const binding = this.deps.runtimes.ownerOf(id);
    if (!binding)
      return {
        session_id: id,
        owner: null,
        unresolved: this.deps.runtimes.hasUnreleasedHuddle(id),
      };
    if (binding.role !== 'huddle')
      throw ApiError.conflict('huddle_identity_changed', 'Placement owner is not a huddle');
    try {
      const state = await this.deps.controls.inspect(id, scope.valid);
      scope.check();
      return {
        session_id: id,
        unresolved: false,
        owner: {
          connected: true,
          target: huddleControlTarget(state),
          build: state.build,
          lifetime: state.lifetime,
          lifecycle: state.control.state,
          executing: state.executing,
          stopping:
            state.state !== 'running' ||
            this.deps.runtimes.stopRequested(state.identity.runtime_id),
          failure: state.failure,
        },
      };
    } catch (error) {
      scope.check();
      if (
        !(error instanceof ApiError) ||
        !['huddle_unavailable', 'huddle_outcome_unknown', 'huddle_persistence_pending'].includes(
          error.code,
        )
      )
        throw error;
      const current = this.deps.runtimes.ownerOf(id);
      if (!current)
        return {
          session_id: id,
          owner: null,
          unresolved: this.deps.runtimes.hasUnreleasedHuddle(id),
        };
      return {
        session_id: id,
        unresolved: true,
        owner: {
          connected: false,
          identity: { runtimeId: current.runtime_id, incarnation: current.incarnation },
          build: current.build,
        },
      };
    }
  }

  private source<T>(
    profile: string,
    session: Session,
    input: HuddleStart,
    authority: Authority,
    use: (prepared: ReturnType<typeof prepareHuddleActivation>, valid: Authority) => Promise<T>,
  ) {
    return this.deps.definitions.withSnapshot(
      profile,
      {
        project_id: session.project_id,
        worktree: session.worktree_path,
        huddle_id: session.huddle_id!,
      },
      authority,
      async (snapshot, location) => {
        if (snapshot.digest !== input.expected_digest)
          throw ApiError.conflict(
            'huddle_source_changed',
            'Saved huddle source changed; inspect it before starting or applying',
          );
        const observeSession = (reference: string, worktree: string, kind: 'any' | 'agent') => {
          const selected = this.deps.sessions.get(reference);
          if (
            selected.project_id !== session.project_id ||
            selected.kind === 'huddle' ||
            (kind === 'agent' &&
              (selected.kind !== 'agent' ||
                ['archived', 'exited', 'interrupted'].includes(selected.status))) ||
            realpathSync(selected.worktree_path) !== worktree
          )
            throw ApiError.conflict(
              'huddle_session_unavailable',
              kind === 'agent'
                ? 'Choose a running agent in the declared project/worktree'
                : 'Choose an agent or terminal in the declared project/worktree',
            );
          return selected.id;
        };
        let prepared: ReturnType<typeof prepareHuddleActivation>;
        try {
          const bindings = huddleExecutionBindings(
            snapshot,
            input.variables,
            location.worktrees,
            this.deps.agentBinding &&
              ((reference, worktree) =>
                this.deps.agentBinding!(profile, session.project_id, reference, worktree)),
            observeSession,
          );
          prepared = prepareHuddleActivation(
            snapshot,
            { id: randomUUID(), worktree: location.worktree, variables: input.variables, bindings },
            session.huddle_id!,
          );
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw ApiError.conflict(
            'huddle_activation_invalid',
            (error instanceof Error ? error.message : 'Invalid huddle activation').slice(0, 4096),
          );
        }
        const recheck = () => {
          location.check();
          const current = huddleExecutionBindings(
            snapshot,
            input.variables,
            location.worktrees,
            this.deps.agentBinding &&
              ((reference, worktree) =>
                this.deps.agentBinding!(profile, session.project_id, reference, worktree)),
            observeSession,
          );
          if (canonicalHuddleJson(current) !== canonicalHuddleJson(prepared.activation.bindings))
            throw ApiError.conflict(
              'huddle_binding_changed',
              'A node resource changed during admission; review the bindings again',
            );
        };
        await this.deps.storage?.assertAdmission([this.deps.home, location.worktree]);
        recheck();
        return use(prepared, () => {
          try {
            recheck();
            return true;
          } catch {
            return false;
          }
        });
      },
    );
  }

  async start(profile: string, id: string, raw: HuddleStart, authority: Authority) {
    const input = huddleStartSchema.parse(raw);
    const scope = this.scope(profile, id, authority, true);
    return this.source(
      profile,
      scope.session,
      input,
      scope.valid,
      async ({ snapshot, activation }, valid) => {
        scope.check();
        const launcher = this.deps.launcher;
        if (!launcher)
          throw ApiError.conflict(
            'huddle_runtime_unavailable',
            'Huddle runtime launch is unavailable',
          );
        try {
          await launcher.checkHuddleAvailable();
        } catch {
          scope.check();
          throw ApiError.conflict(
            'huddle_runtime_unavailable',
            'Select a runtime with huddle support and an available lifetime',
          );
        }
        scope.check();
        if (this.deps.runtimes.hasUnreleasedHuddle(id))
          throw ApiError.conflict(
            'huddle_owned',
            'Inspect and re-arm the existing owner before starting another',
          );
        await launcher.launchHuddle(id, {
          snapshot,
          hostId: huddleHostIdentity(this.deps.home),
          variables: activation.variables,
          bindings: activation.bindings,
          authorised: valid,
        });
        // A lost launch/arm reply is observation-only. A launched but unarmed owner remains inspectable.
        const state = await this.deps.controls.inspect(id, valid);
        await this.deps.controls.arm(id, huddleControlTarget(state), false, valid);
        scope.check();
        return this.inspect(profile, id, authority);
      },
    );
  }

  async apply(profile: string, id: string, raw: HuddleApply, authority: Authority) {
    const input = huddleApplySchema.parse(raw);
    const scope = this.scope(profile, id, authority, true);
    return this.source(
      profile,
      scope.session,
      input,
      scope.valid,
      async ({ snapshot, activation }, valid) => {
        const state = await this.deps.controls.inspect(id, valid);
        requireHuddleControl(state, input.target);
        if (
          Object.values(snapshot.components).some(
            (component) =>
              component.category === 'script' && component.capabilities.includes('sessions'),
          ) &&
          state.capabilities.operations !== 2
        )
          throw ApiError.conflict(
            'huddle_execution_unsupported',
            'This owner cannot dispatch agent operations; start with a supporting runtime',
          );
        try {
          requireHuddleHostFeatures(snapshot, state.capabilities);
        } catch (error) {
          throw ApiError.conflict(
            'huddle_execution_unsupported',
            error instanceof Error ? error.message : String(error),
          );
        }
        scope.check();
        new HuddleRevisionStore(
          this.deps.home,
          input.target.runtimeId,
          scope.session.huddle_id!,
        ).publish(snapshot);
        const { appliedAt: _appliedAt, ...intent } = activation;
        await this.deps.controls.apply(id, intent, input.target, valid);
        scope.check();
        return this.inspect(profile, id, authority);
      },
    );
  }

  async rearm(profile: string, id: string, raw: HuddleLifecycleCommand, authority: Authority) {
    const input = huddleLifecycleCommandSchema.parse(raw);
    const scope = this.scope(profile, id, authority, true);
    await this.deps.controls.arm(id, input.target, false, scope.valid);
    scope.check();
    return this.inspect(profile, id, authority);
  }

  async run(profile: string, id: string, raw: HuddleRun, authority: Authority) {
    const input = huddleRunSchema.parse(raw);
    const scope = this.scope(profile, id, authority, true);
    const accepted = await this.deps.controls.trigger(
      id,
      input.target,
      input.node,
      input.event_id,
      input.data,
      scope.valid,
    );
    scope.check();
    return accepted;
  }

  async interrupt(profile: string, id: string, raw: HuddleLifecycleCommand, authority: Authority) {
    const input = huddleLifecycleCommandSchema.parse(raw);
    const scope = this.scope(profile, id, authority);
    await this.deps.controls.interrupt(id, input.target, scope.valid);
    scope.check();
    return this.inspect(profile, id, authority);
  }

  async stop(profile: string, id: string, raw: HuddleLifecycleCommand, authority: Authority) {
    const input = huddleLifecycleCommandSchema.parse(raw);
    const scope = this.scope(profile, id, authority);
    await this.deps.controls.stop(id, scope.valid, (state) =>
      requireHuddleControl(state, input.target),
    );
    scope.check();
    return { stopped: true as const };
  }

  async history(profile: string, id: string, raw: HuddleHistoryRequest, authority: Authority) {
    const input = huddleHistoryRequestSchema.parse(raw);
    const scope = this.scope(profile, id, authority);
    const { owner, ...query } = input;
    const page = await this.deps.controls.records(id, owner, query, scope.valid);
    scope.check();
    if (page.collection === 'executions')
      return {
        ...page,
        records: page.records.map(({ ordinal, record }) => ({
          ordinal,
          record: huddleExecutionViewSchema.parse(record),
        })),
      };
    if (page.collection === 'invocations')
      return {
        ...page,
        records: page.records.map(({ ordinal, record }) => ({
          ordinal,
          record: huddleInvocationViewSchema.parse(record),
        })),
      };
    return {
      ...page,
      records: page.records.map(({ ordinal, record }) => ({
        ordinal,
        record: huddleOperationViewSchema.parse(record),
      })),
    };
  }
}
