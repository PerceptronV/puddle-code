import { closeSync, fsyncSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  huddleOwnerLaunchSchema,
  huddleOwnerStateSchema,
  supportsHuddleRuntime,
  type HuddleOwnerLaunch,
  type HuddleOwnerRequest,
  type HuddleOwnerResponse,
  type HuddleOwnerState,
  type HuddleSessionFeedCursor,
  type HuddleCompletionBaseline,
} from '@puddle/shared';
import { atomicPrivateJson, syncPrivateDirectory } from '@puddle/shared/node';
import { prepareRuntimeLifetime } from '../lifecycle/lifetime.js';
import { RuntimeOwnerMemory } from '../resources/host/owner.js';
import { HuddleLedger } from './state/ledger.js';
import { HuddleRevisionStore } from './state/revisions.js';
import { HuddleRevisionController, prepareHuddleActivation } from './control/revisions.js';
import { admitManualHuddle } from './control/manual.js';
import { HuddleScheduler } from './execution/scheduler.js';
import { HuddleOwnerServer } from './transport/server.js';
import { requireHuddleDefinitionLocation } from '../../huddle/definitions/location.js';
import { HuddleTimerController } from './triggers/controller.js';
import { HuddleSessionController } from './triggers/sessions/controller.js';
import { HuddleCompletionController } from './triggers/completions/controller.js';
import { completionDefinitions } from './triggers/completions/definitions.js';
import { requireSessionBaseline } from './triggers/sessions/definitions.js';
import { HuddleGitController } from './triggers/git/controller.js';
import { HuddleFiletreeController } from './triggers/filetree/controller.js';
import { requireHuddleFeatures } from './triggers/definitions.js';
import { HuddleOperationMailbox } from './operations/mailbox.js';
import { HuddleCustomTriggerController } from './triggers/custom/controller.js';

/** One independent graph owner. It never opens the application's database or creates a PTY. */
export class HuddleOwner {
  private readonly ledger: HuddleLedger;
  private readonly store: HuddleRevisionStore;
  private readonly revisions: HuddleRevisionController;
  private readonly scheduler: HuddleScheduler;
  private readonly transport: HuddleOwnerServer;
  private readonly operations: HuddleOperationMailbox;
  private readonly timers: HuddleTimerController;
  private readonly filetrees: HuddleFiletreeController;
  private readonly git: HuddleGitController;
  private readonly sessions: HuddleSessionController;
  private readonly completions: HuddleCompletionController;
  private readonly custom: HuddleCustomTriggerController;
  private status: HuddleOwnerState['state'] = 'running';
  private failure: string | null = null;
  private observation = 0;
  private persistencePending = false;
  private stopping: Promise<void> | null = null;
  private interrupting: Promise<void> | null = null;
  private driving: Promise<void> | null = null;
  private releaseLifetime: (() => void) | null = null;
  private triggerEpoch = 0;

  private constructor(
    home: string,
    private readonly memory: RuntimeOwnerMemory<HuddleOwnerLaunch>,
    workerEntry: string,
  ) {
    const launch = memory.launch;
    this.ledger = new HuddleLedger(home, launch.scope);
    try {
      this.store = new HuddleRevisionStore(
        home,
        launch.identity.runtime_id,
        launch.scope.huddleId,
        {},
        memory.allowance,
      );
      this.revisions = new HuddleRevisionController(this.ledger, this.store);
      this.operations = new HuddleOperationMailbox(
        launch.identity,
        this.ledger,
        this.revisions,
        () => this.persist(),
        memory.allowance,
      );
      this.scheduler = new HuddleScheduler(this.ledger, this.revisions, {
        nodePath: process.execPath,
        entryPath: realpathSync(workerEntry),
        allowance: memory.allowance,
        operation: (request, invocation, signal) => {
          if (!launch.capabilities.operations)
            throw new Error('Owner has no host-operation capability');
          return this.operations.request(request, invocation, signal);
        },
      });
      this.timers = new HuddleTimerController(
        this.ledger,
        this.store,
        launch.capabilities,
        () => this.drive(),
        (error) => this.triggerFailure(error),
        () =>
          requireHuddleDefinitionLocation(
            launch.identity.canonical_worktree_path,
            launch.scope.huddleId,
          ),
        memory.allowance,
      );
      this.filetrees = new HuddleFiletreeController(
        this.ledger,
        this.store,
        launch.capabilities,
        () => this.drive(),
        (error) => this.triggerFailure(error),
        () =>
          requireHuddleDefinitionLocation(
            launch.identity.canonical_worktree_path,
            launch.scope.huddleId,
          ),
        memory.allowance,
      );
      this.git = new HuddleGitController(
        this.ledger,
        this.store,
        launch.capabilities,
        () => this.drive(),
        (error) => this.triggerFailure(error),
        () =>
          requireHuddleDefinitionLocation(
            launch.identity.canonical_worktree_path,
            launch.scope.huddleId,
          ),
        memory.allowance,
      );
      this.sessions = new HuddleSessionController(
        this.ledger,
        this.store,
        launch.capabilities,
        () =>
          requireHuddleDefinitionLocation(
            launch.identity.canonical_worktree_path,
            launch.scope.huddleId,
          ),
        memory.allowance,
      );
      this.completions = new HuddleCompletionController(
        this.ledger,
        this.store,
        launch.capabilities,
        () =>
          requireHuddleDefinitionLocation(
            launch.identity.canonical_worktree_path,
            launch.scope.huddleId,
          ),
        memory.allowance,
      );
      this.custom = new HuddleCustomTriggerController(
        this.ledger,
        this.store,
        launch.capabilities,
        {
          nodePath: process.execPath,
          entryPath: realpathSync(workerEntry),
          allowance: memory.allowance,
        },
        () => this.drive(),
        () => this.persist(),
        (error) => this.triggerFailure(error),
        () =>
          requireHuddleDefinitionLocation(
            launch.identity.canonical_worktree_path,
            launch.scope.huddleId,
          ),
      );
      this.transport = new HuddleOwnerServer(home, launch, memory.allowance, (request) =>
        this.execute(request),
      );
    } catch (error) {
      this.ledger.close();
      throw error;
    }
  }

  static async start(home: string, id: string, build: string, workerEntry: string) {
    const memory = await RuntimeOwnerMemory.openWithLaunch(home, id, (value) =>
      huddleOwnerLaunchSchema.parse(value),
    );
    let owner: HuddleOwner | undefined;
    try {
      if (memory.launch.build !== build)
        throw new Error('Huddle owner build differs from its pinned launch');
      if (!supportsHuddleRuntime(memory.launch.capabilities))
        throw new Error('Huddle launch requires unsupported runtime capabilities');
      owner = new HuddleOwner(home, memory, workerEntry);
      owner.releaseLifetime = await prepareRuntimeLifetime(home, memory.launch);
      // Consume once before activating source or listening. Owner replacement needs a separate fenced recovery.
      const fd = openSync(join(memory.directory, 'consumed.json'), 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ format: 1, identity: memory.launch.identity }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      syncPrivateDirectory(memory.directory);
      const { initial } = memory.launch;
      const snapshot = owner.store.read(initial.revision);
      requireHuddleFeatures(snapshot, memory.launch.capabilities);
      owner.revisions.apply(snapshot, initial, 0);
      owner.persist();
      await owner.transport.listen();
      return owner;
    } catch (error) {
      if (owner) {
        await owner.transport.close();
        owner.releaseLifetime?.();
        owner.ledger.close();
      }
      memory.close();
      memory.claim.release();
      throw error;
    }
  }

  state(): HuddleOwnerState {
    const launch = this.memory.launch;
    return huddleOwnerStateSchema.parse({
      format: 1,
      role: 'huddle',
      contract: launch.contract,
      capabilities: launch.capabilities,
      identity: launch.identity,
      scope: launch.scope,
      build: launch.build,
      lifetime: launch.lifetime,
      state: this.status,
      observation: this.observation,
      persistencePending: this.persistencePending,
      executing: this.driving !== null,
      commandCursor: this.transport.commandCursor,
      control: this.ledger.activations.current(),
      liveWorkers: this.scheduler.hasLiveWorkers || this.custom.hasLiveWorkers,
      failure: this.failure,
      ...(launch.capabilities.customTriggers === 1
        ? {
            customTriggers: this.ledger.customTriggers
              .list()
              .filter(
                (source) => source.activationId === this.ledger.activations.current().activationId,
              )
              .map((source) => ({
                node: source.node,
                health:
                  source.health.state === 'gap'
                    ? { state: 'gap', message: source.health.message }
                    : source.health,
              })),
          }
        : {}),
    });
  }
  private persist() {
    this.persistencePending = true;
    const state = huddleOwnerStateSchema.parse({
      ...this.state(),
      observation: this.observation + 1,
      persistencePending: false,
    });
    atomicPrivateJson(join(this.memory.directory, 'huddle-owner.json'), state, {
      syncDirectory: true,
    });
    this.observation = state.observation;
    this.persistencePending = false;
    this.transport.changed(this.observation);
  }
  private drive() {
    if (this.failure || this.stopping || this.interrupting) return;
    // Admission must wake a running scheduler too: another root may have a free slot.
    const pending = this.scheduler.drain();
    if (this.driving === pending) return;
    this.driving = pending;
    const finished = (error?: unknown) => {
      if (this.driving === pending) this.driving = null;
      if (error !== undefined) {
        this.stopTriggers();
        this.failure = (error instanceof Error ? error.message : String(error)).slice(0, 4096);
      }
      try {
        this.persist();
      } catch {
        this.stopTriggers();
        this.failure = 'Huddle owner state persistence failed';
      }
    };
    void pending.then(() => finished(), finished);
    this.persist();
  }
  private async execute(request: HuddleOwnerRequest): Promise<HuddleOwnerResponse> {
    const state = (): HuddleOwnerResponse => ({ t: 'state', id: request.id, state: this.state() });
    if (request.t === 'hello' || request.t === 'inspect') return state();
    if (request.t === 'completion-plan') {
      if (this.memory.launch.capabilities.completionPlans !== 1)
        throw new Error('Owner has no completion plan capability');
      const control = this.ledger.activations.current();
      if (!control.activationId) throw new Error('Huddle has no activation');
      const activation = request.activation
        ? prepareHuddleActivation(
            this.store.read(request.activation.revision),
            request.activation,
            this.ledger.identity.huddleId,
          ).activation
        : this.ledger.activations.get(control.activationId);
      if (activation.worktree !== this.memory.launch.identity.canonical_worktree_path)
        throw new Error('Huddle definition worktree cannot change within an owner');
      const snapshot = this.store.read(activation.revision);
      requireHuddleFeatures(snapshot, this.memory.launch.capabilities);
      return {
        t: 'completion-plan',
        id: request.id,
        plan: {
          generation: control.generation,
          activationId: activation.id,
          revision: activation.revision,
          sources: completionDefinitions(snapshot, activation).map(
            ({ slot: _slot, ...source }) => source,
          ),
        },
      };
    }
    if (
      request.t === 'operation-page' ||
      request.t === 'operation-claim' ||
      request.t === 'operation-unavailable' ||
      request.t === 'operation-settle'
    ) {
      if (!this.memory.launch.capabilities.operations)
        throw new Error('Owner has no host-operation capability');
      if (request.t === 'operation-unavailable') {
        if (this.memory.launch.capabilities.operations !== 2)
          throw new Error('Owner cannot accept dispatch failure reports');
        this.operations.unavailable(request.scope, request.unsent, request.error);
        return { t: 'accepted', id: request.id };
      }
      if (request.t === 'operation-page')
        return { t: 'operation-page', id: request.id, page: this.operations.page(request.after) };
      if (request.t === 'operation-claim') {
        if (this.stopping || this.interrupting || this.failure)
          throw new Error('Huddle cannot dispatch operations during a lifecycle change');
        return {
          t: 'operation-claim',
          id: request.id,
          ...this.operations.claim(request.operationId),
        };
      }
      return {
        t: 'operation-settled',
        id: request.id,
        operationId: request.scope.operationId,
        result: this.operations.settle(request.scope, request.result),
      };
    }
    if (
      request.t === 'session-sources' ||
      request.t === 'session-events' ||
      request.t === 'session-unavailable'
    ) {
      if (this.memory.launch.capabilities.sessionEvents !== 1)
        throw new Error('Owner has no session subscription capability');
      if (request.t === 'session-sources')
        return { t: 'session-sources', id: request.id, sources: this.sessions.list() };
      if (this.stopping || this.interrupting || this.failure)
        throw new Error('Session admission is unavailable');
      // A stale delivery can race Apply/Interrupt; reject it without failing the new activation.
      this.sessions.requireCurrent(request.source);
      try {
        if (request.t === 'session-unavailable')
          throw new Error(`Session ${request.source.node}: observation gap: ${request.error}`);
        if (this.sessions.accept(request.source, request.page)) this.drive();
      } catch (error) {
        this.triggerFailure(error);
        throw error;
      }
      return { t: 'accepted', id: request.id };
    }
    if (
      request.t === 'completion-sources' ||
      request.t === 'completion-events' ||
      request.t === 'completion-unavailable'
    ) {
      if (this.memory.launch.capabilities.completionEvents !== 1)
        throw new Error('Owner has no completion subscription capability');
      if (request.t === 'completion-sources')
        return { t: 'completion-sources', id: request.id, sources: this.completions.list() };
      if (this.stopping || this.interrupting || this.failure)
        throw new Error('Completion admission is unavailable');
      this.completions.requireCurrent(request.source);
      try {
        if (request.t === 'completion-unavailable')
          throw new Error(`Completion ${request.source.node}: observation gap: ${request.error}`);
        if (this.completions.accept(request.source, request.page)) this.drive();
      } catch (error) {
        this.triggerFailure(error);
        throw error;
      }
      return { t: 'accepted', id: request.id };
    }
    if (request.t === 'records') {
      return {
        t: 'records',
        id: request.id,
        rows: this.ledger
          .page(request.collection, {
            after: request.after,
            ...(request.parent === undefined ? {} : { parent: request.parent }),
          })
          .map(({ ordinal, id, body }) => ({ ordinal, id, body })),
      };
    }
    if (request.t === 'shutdown') {
      this.stopTriggers();
      // Acknowledgement is acceptance only. Retain ownership until workers and queued controls have drained.
      setImmediate(() => {
        void this.stop().catch(() => {});
      });
      return { t: 'accepted', id: request.id };
    }
    if (this.stopping || this.interrupting) throw new Error('Huddle lifecycle change is pending');
    if (request.t === 'interrupt') {
      this.stopTriggers();
      this.interrupting = this.scheduler.halt('interrupted', 'Huddle interrupted by controller');
      try {
        await this.interrupting;
        await Promise.all([this.filetrees.settled(), this.git.settled(), this.custom.settled()]);
        await this.driving;
        this.persist();
      } catch (error) {
        this.failure = (error instanceof Error ? error.message : String(error)).slice(0, 4096);
        this.persist();
        throw error;
      } finally {
        this.interrupting = null;
      }
      return state();
    }
    if (this.failure) throw new Error('Huddle owner needs recovery');
    if (request.t === 'readout-observe') {
      if (this.memory.launch.capabilities.readoutObservation !== 1)
        throw new Error('Owner has no readout observation capability');
      const control = this.ledger.activations.current();
      if (
        control.generation !== request.expectedGeneration ||
        control.activationId !== request.activationId
      )
        throw new Error('Readout observation review is stale');
      requireHuddleDefinitionLocation(
        this.memory.launch.identity.canonical_worktree_path,
        this.memory.launch.scope.huddleId,
      );
      this.scheduler.observeReadout(request.operationId);
      this.drive();
      return { t: 'accepted', id: request.id };
    }
    if (
      (request.t === 'apply' || request.t === 'arm') &&
      request.completionBaselines !== undefined &&
      this.memory.launch.capabilities.completionEvents !== 1
    )
      throw new Error('Owner has no completion subscription capability');
    if (request.t === 'apply') {
      if (
        realpathSync(request.activation.worktree) !==
        this.memory.launch.identity.canonical_worktree_path
      )
        throw new Error('Huddle definition worktree cannot change within an owner');
      const snapshot = this.store.read(request.activation.revision);
      requireHuddleFeatures(snapshot, this.memory.launch.capabilities);
      if (this.ledger.activations.current().state === 'armed') {
        requireSessionBaseline(snapshot, request.feedBaseline);
        const prepared = prepareHuddleActivation(
          snapshot,
          request.activation,
          this.ledger.identity.huddleId,
        );
        this.completions.validate(
          prepared.snapshot,
          prepared.activation,
          request.completionBaselines,
        );
      }
      this.revisions.apply(snapshot, request.activation, request.expectedGeneration);
      await this.refreshTriggers(request.feedBaseline, request.completionBaselines);
      return state();
    }
    if (request.t === 'arm') {
      const control = this.ledger.activations.current();
      if (control.activationId) {
        const activation = this.ledger.activations.get(control.activationId);
        const snapshot = this.store.read(activation.revision);
        requireSessionBaseline(snapshot, request.feedBaseline);
        this.completions.validate(snapshot, activation, request.completionBaselines);
      }
      this.ledger.activations.setIntent(request.expectedGeneration, 'armed', request.autoStart);
      await this.refreshTriggers(request.feedBaseline, request.completionBaselines);
      this.drive();
      return state();
    }
    const accepted = admitManualHuddle(
      this.ledger,
      this.store,
      request.node,
      request.eventId,
      request.data,
    );
    this.drive();
    return {
      t: 'run',
      id: request.id,
      executionId: accepted.execution.id,
      duplicate: accepted.duplicate,
    };
  }

  private stopTriggers() {
    this.triggerEpoch++;
    this.timers.stop();
    this.filetrees.stop();
    this.git.stop();
    this.sessions.stop();
    this.completions.stop();
    this.custom.stop();
  }
  private triggerFailure(error: unknown) {
    this.stopTriggers();
    this.failure = (error instanceof Error ? error.message : String(error)).slice(0, 4096);
    try {
      this.persist();
    } catch {
      this.failure = 'Huddle trigger state persistence failed';
    }
  }
  private async refreshTriggers(
    baseline?: HuddleSessionFeedCursor,
    completionBaselines?: HuddleCompletionBaseline[],
  ) {
    this.stopTriggers();
    const epoch = this.triggerEpoch;
    const current = () => epoch === this.triggerEpoch && !this.stopping && !this.interrupting;
    try {
      await Promise.all([this.filetrees.settled(), this.git.settled(), this.custom.settled()]);
      if (!current()) return;
      this.persist();
      await this.filetrees.refresh();
      if (!current()) return;
      if (this.failure) throw new Error(this.failure);
      await this.git.refresh();
      if (!current()) return;
      if (this.failure) throw new Error(this.failure);
      this.sessions.refresh(baseline);
      this.completions.refresh(completionBaselines);
      await this.custom.refresh();
      if (!current()) return;
      this.timers.refresh();
    } catch (error) {
      if (!current()) return;
      this.stopTriggers();
      this.failure = (error instanceof Error ? error.message : String(error)).slice(0, 4096);
      this.persist();
      throw error;
    }
  }

  stop(): Promise<void> {
    if (!this.stopping) this.stopping = this.shutdown();
    return this.stopping;
  }
  private async shutdown() {
    this.stopTriggers();
    this.status = 'stopping';
    try {
      this.persist();
      await this.interrupting;
      await this.scheduler.halt('stopped', 'Huddle owner stopped');
      await Promise.all([this.filetrees.settled(), this.git.settled(), this.custom.settled()]);
      await this.driving;
      if (this.scheduler.hasLiveWorkers || this.custom.hasLiveWorkers)
        throw new Error('Huddle worker termination remains unknown');
      await this.transport.close();
      this.status = 'exited';
      this.persist();
      this.ledger.close();
      this.releaseLifetime?.();
      this.memory.close();
      this.memory.claim.release();
    } catch (error) {
      this.failure = (error instanceof Error ? error.message : String(error)).slice(0, 4096);
      try {
        this.persist();
      } catch {
        /* Retain claims; failed writes are not shutdown proof. */
      }
      throw error;
    }
  }
}
