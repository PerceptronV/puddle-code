import { huddleSecretResolver } from '../integrations/secrets.js';
import type { HuddleOfflineReadouts } from './readouts/offline.js';
import { retainedHuddleLaunch } from './retained/identity.js';
import { hasHuddleContainment } from '../../runtime/huddle/recovery/containment.js';
import { huddleBindingLaunch } from '../../runtime/huddle/ownership/binding.js';
import { realpathSync } from 'node:fs';
import { readRetainedHuddleHistory } from './history/retained.js';
import { projectHuddleHistory } from './history/projection.js';
import { requireHuddleHostFeatures } from '../../runtime/huddle/triggers/definitions.js';
import { randomUUID } from 'node:crypto';
import {
  huddleStartSchema,
  huddleAutoStartSchema,
  type HuddleAutoStart,
  huddleRecoverSchema,
  type HuddleRecover,
  huddleReadoutObserveSchema,
  huddleRetainedReadoutObserveSchema,
  type HuddleRetainedReadoutObserve,
  type HuddleReadoutObserve,
  huddleApplySchema,
  huddleRunSchema,
  huddleLifecycleCommandSchema,
  huddleHistoryRequestSchema,
  huddleHistoryOwnersRequestSchema,
  huddleRetainedHistoryRequestSchema,
  type HuddleHistoryOwnersRequest,
  type HuddleRetainedHistoryRequest,
  huddleRevisionReviewSchema,
  huddleRetainedRevisionRequestSchema,
  type HuddleRetainedRevisionRequest,
  huddleDiffReviewSchema,
  huddleReviewSchema,
  type HuddleRevisionReview,
  type HuddleDiffReview,
  canonicalHuddleJson,
  type HuddleStart,
  type HuddleApply,
  type HuddleRun,
  type HuddleLifecycleCommand,
  type HuddleHistoryRequest,
  type HuddleRuntimeInspection,
  type Session,
  type HuddleComponent,
  type HuddleJson,
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
import {
  HuddleRevisionStore,
  readRetainedHuddleRevision,
} from '../../runtime/huddle/state/revisions.js';
import { retainedHuddleReview } from './review/retained.js';
import { readHuddleActivation } from '../../runtime/huddle/state/readers/activation.js';
import { compareHuddleRevisions } from './review/compare.js';
import type { HuddleDefinitionSnapshot } from '../definitions/capture.js';
import { KeyedMutex } from '../../git/mutex.js';
import { prepareHuddleActivation } from '../../runtime/huddle/control/revisions.js';
import type { StorageMonitor } from '../../storage/monitor.js';
import type { HuddleService } from '../control/service.js';
import { ApiError } from '../../http/errors.js';
import { huddleExecutionBindings } from './bindings.js';
import { huddleHostIdentity } from './host.js';
import { requireHuddleSource } from './source.js';
import { huddleResourceBindings, type HuddleResourceStores } from './resources.js';

type Authority = () => boolean;
interface Dependencies extends HuddleResourceStores {
  home: string;
  profiles: Pick<ProfileStore, 'get'>;
  projects: Pick<ProjectStore, 'get'>;
  sessions: Pick<SessionStore, 'get'>;
  runtimes: Pick<
    RuntimeStore,
    | 'ownerOf'
    | 'unresolvedHuddle'
    | 'hasUnreleasedHuddle'
    | 'stopRequested'
    | 'get'
    | 'huddleHistory'
  >;
  definitions: HuddleService;
  controls: HuddleRuntimeControls;
  launcher?: Pick<RuntimeLauncher, 'launchHuddle' | 'checkHuddleAvailable'> &
    Partial<Pick<RuntimeLauncher, 'recoverHuddle'>>;
  offlineReadouts?: HuddleOfflineReadouts;
  storage?: Pick<StorageMonitor, 'assertAdmission'>;
  agentBinding?: (
    profile: string,
    project: string,
    reference: string,
    worktree: string,
    lifecycle?: 'resume' | 'restart',
  ) => string;
}

/** Local/SSH placement authority surrounds every private owner operation. */
export class HuddleExecutionService {
  private readonly reviewQueue = new KeyedMutex();
  private pendingReviews = 0;
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
    includeReadoutObservation = false,
    includeCustomTriggers = false,
    includeRecovery = false,
    includeAutoStart = false,
    includeTriggerInspection = false,
    includeCrashRecovery = false,
  ): Promise<HuddleRuntimeInspection> {
    const scope = this.scope(profile, id, authority);
    const recovery = () => {
      if (!includeRecovery || !this.deps.launcher?.recoverHuddle) return {};
      const candidate = this.deps.runtimes.unresolvedHuddle(id);
      let crashRecovery = false;
      if (candidate && includeCrashRecovery) {
        try {
          crashRecovery = hasHuddleContainment(
            this.deps.home,
            huddleBindingLaunch(this.deps.home, candidate),
          );
        } catch {
          /* Missing retained metadata cannot offer same-boot recovery. */
        }
      }
      return candidate
        ? {
            recovery: {
              owner: { runtimeId: candidate.runtime_id, incarnation: candidate.incarnation },
              ...(crashRecovery ? { crash_recovery: true as const } : {}),
            },
          }
        : {};
    };
    const binding = this.deps.runtimes.ownerOf(id);
    if (!binding)
      return {
        session_id: id,
        owner: null,
        ...recovery(),
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
          ...(includeTriggerInspection && state.capabilities.triggerInspection === 1
            ? { trigger_inspection: true as const }
            : {}),
          ...(includeAutoStart && state.capabilities.autoStart === 1
            ? { auto_start: state.control.autoStart }
            : {}),
          executing: state.executing,
          stopping:
            state.state !== 'running' ||
            this.deps.runtimes.stopRequested(state.identity.runtime_id),
          failure: state.failure,
          ...(includeReadoutObservation && state.capabilities.readoutObservation === 1
            ? { readout_observation: true as const }
            : {}),
          ...(includeCustomTriggers &&
          state.capabilities.customTriggers === 1 &&
          state.customTriggers
            ? { custom_triggers: state.customTriggers }
            : {}),
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
          ...recovery(),
          unresolved: this.deps.runtimes.hasUnreleasedHuddle(id),
        };
      return {
        session_id: id,
        unresolved: true,
        ...recovery(),
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
        const secrets = huddleSecretResolver(this.deps.home, {
          profileId: profile,
          projectId: session.project_id,
          huddleId: session.huddle_id!,
          worktree: location.worktree,
        });
        const resources = (component: HuddleComponent, values: Record<string, HuddleJson>) => {
          secrets(component, values);
          return huddleResourceBindings(this.deps, profile, session.project_id, component, values);
        };
        let prepared: ReturnType<typeof prepareHuddleActivation>;
        try {
          const bindings = huddleExecutionBindings(
            snapshot,
            input.variables,
            location.worktrees,
            this.deps.agentBinding &&
              ((reference, worktree, lifecycle) =>
                this.deps.agentBinding!(
                  profile,
                  session.project_id,
                  reference,
                  worktree,
                  lifecycle,
                )),
            observeSession,
            resources,
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
              ((reference, worktree, lifecycle) =>
                this.deps.agentBinding!(
                  profile,
                  session.project_id,
                  reference,
                  worktree,
                  lifecycle,
                )),
            observeSession,
            resources,
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

  async recover(profile: string, id: string, raw: HuddleRecover, authority: Authority) {
    const input = huddleRecoverSchema.parse(raw);
    const scope = this.scope(profile, id, authority, true);
    if (!this.deps.launcher?.recoverHuddle)
      throw ApiError.conflict('huddle_recovery_unsupported', 'Huddle recovery is unavailable');
    await this.deps.storage?.assertAdmission([this.deps.home, scope.session.worktree_path]);
    scope.check();
    try {
      await this.deps.launcher.recoverHuddle(
        id,
        input.owner,
        scope.valid,
        input.after === 'owner-crash' ? { after: 'owner-crash' } : {},
      );
    } catch (error) {
      scope.check();
      if (error instanceof ApiError) throw error;
      throw ApiError.conflict(
        'huddle_recovery_unavailable',
        error instanceof Error ? error.message : 'Huddle recovery is unavailable',
      );
    }
    scope.check();
    return this.inspect(profile, id, authority, false, false, true);
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
              component.category !== 'trigger' && component.capabilities.includes('sessions'),
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

  async triggers(profile: string, id: string, raw: HuddleLifecycleCommand, authority: Authority) {
    const input = huddleLifecycleCommandSchema.parse(raw);
    const scope = this.scope(profile, id, authority);
    const report = await this.deps.controls.triggers(id, input.target, scope.valid);
    scope.check();
    return report;
  }

  async autoStart(profile: string, id: string, raw: HuddleAutoStart, authority: Authority) {
    const input = huddleAutoStartSchema.parse(raw);
    const scope = this.scope(profile, id, authority, input.enabled);
    await this.deps.controls.autoStart(
      id,
      input.target,
      input.expected,
      input.enabled,
      scope.valid,
    );
    scope.check();
    return this.inspect(profile, id, authority, false, false, false, true);
  }

  async rearm(profile: string, id: string, raw: HuddleLifecycleCommand, authority: Authority) {
    const input = huddleLifecycleCommandSchema.parse(raw);
    const scope = this.scope(profile, id, authority, true);
    await this.deps.controls.arm(id, input.target, undefined, scope.valid);
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
    const { owner, include_readout_observation, ...query } = input;
    const page = await this.deps.controls.records(id, owner, query, scope.valid);
    scope.check();
    return projectHuddleHistory(page, include_readout_observation);
  }

  historyOwners(
    profile: string,
    id: string,
    raw: HuddleHistoryOwnersRequest,
    authority: Authority,
  ) {
    const input = huddleHistoryOwnersRequestSchema.parse(raw);
    const scope = this.scope(profile, id, authority);
    const records = this.deps.runtimes.huddleHistory(id, input.after);
    for (const binding of records) {
      if (
        binding.profile_id !== profile ||
        binding.project_id !== scope.session.project_id ||
        binding.huddle_id !== scope.session.huddle_id ||
        binding.canonical_worktree_path !== scope.session.worktree_path
      )
        throw ApiError.conflict(
          'huddle_history_changed',
          'Recorded huddle placement identity changed',
        );
    }
    scope.check();
    const last = records.at(-1);
    return {
      source: 'recorded-bindings' as const,
      records: records.map((binding) => ({
        owner: { runtimeId: binding.runtime_id, incarnation: binding.incarnation },
        build: binding.build,
        recorded_state: binding.state,
        created_at: binding.created_at,
        ended_at: binding.ended_at,
      })),
      next:
        records.length === 64 && last
          ? { created_at: last.created_at, runtime_id: last.runtime_id }
          : null,
    };
  }

  retainedHistory(
    profile: string,
    id: string,
    raw: HuddleRetainedHistoryRequest,
    authority: Authority,
  ) {
    const input = huddleRetainedHistoryRequestSchema.parse(raw);
    const scope = this.scope(profile, id, authority);
    if (this.pendingReviews >= 8)
      throw ApiError.conflict('huddle_review_busy', 'Too many pending history or revision reads');
    this.pendingReviews++;
    return this.reviewQueue
      .run('source', async () => {
        scope.check();
        const binding = this.deps.runtimes.get(input.owner.runtimeId);
        const result = readRetainedHuddleHistory(
          this.deps.home,
          profile,
          scope.session,
          binding,
          input,
        );
        scope.check();
        return result;
      })
      .finally(() => {
        this.pendingReviews--;
      });
  }

  retainedRevision(
    profile: string,
    id: string,
    raw: HuddleRetainedRevisionRequest,
    authority: Authority,
  ) {
    const input = huddleRetainedRevisionRequestSchema.parse(raw);
    const scope = this.scope(profile, id, authority);
    if (this.pendingReviews >= 8)
      throw ApiError.conflict('huddle_review_busy', 'Too many pending history or revision reads');
    this.pendingReviews++;
    return this.reviewQueue
      .run('source', async () => {
        scope.check();
        const review = retainedHuddleReview({
          home: this.deps.home,
          profile,
          session: scope.session,
          binding: () => this.deps.runtimes.get(input.owner.runtimeId),
          input,
        });
        const finish = (saved?: HuddleDefinitionSnapshot) => {
          scope.check();
          const result = review.finish(saved);
          scope.check();
          return result;
        };
        if (!input.expected_digest) return finish();
        return this.deps.definitions.withSnapshot(
          profile,
          {
            project_id: scope.session.project_id,
            worktree: scope.session.worktree_path,
            huddle_id: scope.session.huddle_id!,
          },
          scope.valid,
          async (saved, location) => {
            location.check();
            const result = finish(saved);
            location.check();
            return result;
          },
        );
      })
      .finally(() => {
        this.pendingReviews--;
      });
  }

  reviewRevision(profile: string, id: string, raw: HuddleRevisionReview, authority: Authority) {
    return this.review(profile, id, huddleRevisionReviewSchema.parse(raw), authority);
  }

  reviewDiff(profile: string, id: string, raw: HuddleDiffReview, authority: Authority) {
    const { expected_digest, ...input } = huddleDiffReviewSchema.parse(raw);
    return this.review(profile, id, input, authority, expected_digest);
  }

  private review(
    profile: string,
    id: string,
    input: HuddleRevisionReview,
    authority: Authority,
    savedDigest?: string,
  ) {
    // One bounded source workspace per controller; waiting callers hold no bundles.
    if (this.pendingReviews >= 8)
      throw ApiError.conflict('huddle_review_busy', 'Too many pending revision reviews');
    this.pendingReviews++;
    return this.reviewQueue
      .run('source', () => this.inspectRevision(profile, id, input, authority, savedDigest))
      .finally(() => {
        this.pendingReviews--;
      });
  }

  private async inspectRevision(
    profile: string,
    id: string,
    input: HuddleRevisionReview,
    authority: Authority,
    savedDigest?: string,
  ) {
    const scope = this.scope(profile, id, authority);
    const state = await this.deps.controls.inspect(id, scope.valid);
    requireHuddleControl(state, input.target);
    scope.check();
    let active: HuddleDefinitionSnapshot;
    let activation: ReturnType<typeof readHuddleActivation>;
    try {
      activation = readHuddleActivation(this.deps.home, state);
      active = readRetainedHuddleRevision(
        this.deps.home,
        input.target.runtimeId,
        scope.session.huddle_id!,
        activation.revision,
      );
    } catch {
      throw ApiError.conflict(
        'huddle_revision_unavailable',
        'The active revision could not be verified; inspect the runtime again',
      );
    }
    const finish = async (saved?: HuddleDefinitionSnapshot) => {
      if (saved && saved.digest !== savedDigest)
        throw ApiError.conflict(
          'huddle_source_changed',
          'Saved source changed; inspect its digest before comparing again',
        );
      let comparison: ReturnType<typeof compareHuddleRevisions>;
      try {
        comparison = compareHuddleRevisions(active, saved, input.entry);
      } catch {
        throw ApiError.badRequest(
          'huddle_review_entry_missing',
          'Choose an entry in the reviewed source closure',
        );
      }
      const current = await this.deps.controls.inspect(id, scope.valid);
      requireHuddleControl(current, input.target);
      scope.check();
      return huddleReviewSchema.parse({
        target: input.target,
        active: activation,
        saved: saved ? { digest: saved.digest, diagnostics: saved.diagnostics } : null,
        ...comparison,
      });
    };
    if (!savedDigest) return finish();
    return this.deps.definitions.withSnapshot(
      profile,
      {
        project_id: scope.session.project_id,
        worktree: scope.session.worktree_path,
        huddle_id: scope.session.huddle_id!,
      },
      scope.valid,
      async (saved, location) => {
        location.check();
        const review = await finish(saved);
        location.check();
        return review;
      },
    );
  }

  async observeRetainedReadout(
    profile: string,
    id: string,
    raw: HuddleRetainedReadoutObserve,
    authority: Authority,
  ) {
    const input = huddleRetainedReadoutObserveSchema.parse(raw);
    const scope = this.scope(profile, id, authority);
    const check = () => {
      scope.check();
      const session = this.deps.sessions.get(id);
      if (session.status === 'archived' || this.deps.projects.get(session.project_id).archived)
        throw ApiError.conflict(
          'huddle_archived',
          'Unarchive the huddle and project before checking a delivery',
        );
      if (realpathSync(session.worktree_path) !== session.worktree_path)
        throw ApiError.conflict('huddle_worktree_changed', 'The recorded worktree moved');
    };
    check();
    if (!this.deps.offlineReadouts)
      throw ApiError.conflict(
        'huddle_execution_unsupported',
        'Retained readout observation is unavailable',
      );
    await this.deps.storage?.assertAdmission([this.deps.home, scope.session.worktree_path]);
    check();
    const binding = this.deps.runtimes.get(input.owner.runtimeId);
    const launch = retainedHuddleLaunch(this.deps.home, profile, scope.session, binding, input);
    try {
      return this.deps.offlineReadouts.observe(binding!, launch, input.operation_id, check);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw ApiError.conflict(
        'huddle_readout_unavailable',
        'Retained readout observation is unavailable; inspect the recorded operation and owner state',
      );
    }
  }

  async observeReadout(
    profile: string,
    id: string,
    raw: HuddleReadoutObserve,
    authority: Authority,
  ) {
    const input = huddleReadoutObserveSchema.parse(raw);
    const scope = this.scope(profile, id, authority, true);
    const accepted = await this.deps.controls.observeReadout(
      id,
      input.target,
      input.operation_id,
      scope.valid,
    );
    scope.check();
    return accepted;
  }
}
