import {
  hostUpdateCommandSchema,
  hostUpdateReplySchema,
  hostUpdateReviewSchema,
  hostUpdateTerminal,
  type HostUpdateCommand,
  type HostUpdateReply,
  type HostUpdateOperation,
  type HostReleaseCapabilities,
  type HostUpdateDaemonHandoff,
} from '@puddle/shared';
import { acquireHostClaim, HostClaimBusy } from '../security/claims.js';
import { HostUpdateConflict, HostUpdateOperations } from './operations/store.js';
import type { HostUpdateInspection, UpdateInspection } from './preflight/inspection.js';
import { readStageCapabilities } from './preflight/candidate.js';

class Rejected extends Error {}
class Unsupported extends Error {}

/** One host-authorised coordinator for CLI and cockpit control requests. */
export class HostUpdateCoordinator {
  private closed = false;
  private maintenance: { operationId: string; release(): void } | undefined;
  constructor(
    private readonly deps: {
      home: string;
      operations: HostUpdateOperations;
      inspection: Pick<HostUpdateInspection, 'inspect'>;
      installedRuntime(): HostReleaseCapabilities['runtime'] | null;
      /** Supplied when all daemon-update admission and recovery participants are composed. */
      pauseDaemon?(): Promise<{ release(): void; outgoing: HostUpdateDaemonHandoff['outgoing'] }>;
      observeAdoption?(operation: HostUpdateOperation, nonce: string): void;
      dispatch(
        operation: HostUpdateOperation,
        kind: 'systemd' | 'launchd',
        authorised: () => boolean,
        daemon?: HostUpdateDaemonHandoff,
      ): Promise<void>;
    },
  ) {}

  close(): void {
    this.closed = true;
  }

  async execute(input: HostUpdateCommand, authorised: () => boolean): Promise<HostUpdateReply> {
    const command = hostUpdateCommandSchema.parse(input);
    const requireAuthority = () => {
      if (this.closed || !authorised()) throw new Rejected();
    };
    const store = this.deps.operations;
    let claim: ReturnType<typeof acquireHostClaim> | undefined;
    let pause: Awaited<ReturnType<NonNullable<typeof this.deps.pauseDaemon>>> | undefined;
    let pausedOperation: string | undefined;
    try {
      requireAuthority();
      this.releaseFinishedMaintenance();
      if (command.action === 'status') {
        const operation = store.read(command.id);
        if (operation && command.adoption_nonce)
          this.deps.observeAdoption?.(operation, command.adoption_nonce);
        requireAuthority();
        return { ok: true, operation };
      }
      claim = acquireHostClaim(this.deps.home, 'host-update-coordinator');
      requireAuthority();
      if (command.action === 'begin') {
        const result = store.begin(command.targets);
        const operation = result.created ? store.downloading(result.operation) : result.operation;
        return { ok: true, operation, created: result.created };
      }
      let operation = store.read(command.reference.id);
      if (!operation || operation.revision !== command.reference.revision)
        throw new HostUpdateConflict('Host update changed', operation);
      if (command.action === 'cancel') {
        operation = store.stopBeforeDispatch(
          operation,
          command.reason === 'cancelled' ? 'cancelled' : 'failed',
          command.reason === 'cancelled' ? 'Cancelled by the user' : 'Host release staging failed',
        );
        return { ok: true, operation };
      }
      if (command.action === 'stage') {
        // Corroborate client-delivered installer output with the exact host files.
        await readStageCapabilities(this.deps.home, command.receipt);
        requireAuthority();
        return { ok: true, operation: store.staged(operation, command.receipt) };
      }
      if (!['staged', 'preflight', 'approved'].includes(operation.phase))
        throw new HostUpdateConflict('Host update is not ready for inspection', operation);
      const runtimeOnly =
        operation.targets.length === 1 && operation.targets[0]?.component === 'runtime';
      if (command.action === 'apply' && !runtimeOnly) {
        if (!this.deps.pauseDaemon) throw new Unsupported();
        pause = await this.deps.pauseDaemon();
        pausedOperation = operation.id;
        requireAuthority();
      }
      const inspection = await this.deps.inspection.inspect(
        operation,
        command.cockpit,
        this.deps.installedRuntime(),
      );
      requireAuthority();
      const review = this.review(inspection, runtimeOnly || !!this.deps.pauseDaemon);
      if (!review.fingerprint) {
        operation = store.stopBeforeDispatch(
          operation,
          'blocked',
          'Host update checks did not pass',
        );
        return { ok: true, operation, review };
      }
      const fingerprint = review.fingerprint;
      if (command.action === 'inspect') {
        operation = store.preflight(operation, fingerprint);
        return { ok: true, operation, review };
      }
      if (command.fingerprint !== fingerprint || operation.preflight !== fingerprint) {
        operation = store.preflight(operation, fingerprint);
        return { ok: false, code: 'conflict', operation };
      }
      const supervisor = inspection.supervision.worker;
      if (!supervisor || inspection.impact.requiresInterruption) throw new Unsupported();
      const daemon =
        !runtimeOnly && pause && inspection.supervision.daemon
          ? { outgoing: pause.outgoing, daemon_service: inspection.supervision.daemon }
          : undefined;
      if (!runtimeOnly && (!daemon || daemon.outgoing.pid !== daemon.daemon_service.pid))
        throw new Unsupported();
      if (operation.phase === 'approved') operation = store.preflight(operation, fingerprint);
      requireAuthority();
      operation = store.approve(operation, fingerprint);
      // The worker dispatcher persists consumption before invoking its supervisor.
      // After that acceptance, lease loss cannot cancel or replay the operation.
      await this.deps.dispatch(
        operation,
        supervisor.kind,
        () => !this.closed && authorised(),
        daemon,
      );
      return { ok: true, operation: store.read(operation.id) };
    } catch (error) {
      if (this.closed || !authorised() || error instanceof Rejected)
        return { ok: false, code: 'rejected', operation: null };
      let operation: HostUpdateOperation | null = null;
      try {
        operation = store.read();
      } catch {
        /* Preserve the original failure. */
      }
      return hostUpdateReplySchema.parse({
        ok: false,
        code:
          error instanceof Unsupported
            ? 'unsupported'
            : error instanceof HostUpdateConflict || error instanceof HostClaimBusy
              ? 'conflict'
              : 'failed',
        operation,
      });
    } finally {
      try {
        if (pause && pausedOperation) {
          let accepted = true;
          try {
            const current = store.read(pausedOperation);
            accepted = current ? current.dispatch_id !== null : true;
          } catch {
            /* Unknown dispatch durability must not reopen mutations. */
          }
          if (accepted) this.maintenance = { operationId: pausedOperation, release: pause.release };
          else pause.release();
        }
      } finally {
        claim?.release();
      }
    }
  }

  /** An ended/fenced worker cannot resume its operation after releasing its execution claim. */
  private releaseFinishedMaintenance(): void {
    const held = this.maintenance;
    if (!held || this.closed) return;
    const operation = this.deps.operations.read(held.operationId);
    if (
      !operation ||
      (!hostUpdateTerminal(operation.phase) && operation.phase !== 'recovery_required')
    )
      return;
    let claim: ReturnType<typeof acquireHostClaim>;
    try {
      claim = acquireHostClaim(this.deps.home, 'host-update-execution');
    } catch (error) {
      if (error instanceof HostClaimBusy) return;
      throw error;
    }
    try {
      held.release();
      this.maintenance = undefined;
    } finally {
      claim.release();
    }
  }

  private review(inspection: UpdateInspection, available: boolean) {
    const affected = inspection.impact.affected;
    const eligible = available && !inspection.impact.requiresInterruption;
    const blockers = available
      ? inspection.impact.requiresInterruption
        ? [...inspection.blockers, { code: 'interruption_approval_required', target: 'daemon' }]
        : inspection.blockers
      : [...inspection.blockers, { code: 'daemon_activation_unavailable', target: 'daemon' }];
    return hostUpdateReviewSchema.parse({
      fingerprint: eligible ? inspection.fingerprint : null,
      can_apply: eligible && inspection.fingerprint !== null,
      blockers: blockers.slice(0, 32),
      more_blockers: Math.max(0, blockers.length - 32),
      affected: {
        terminals: affected.terminals.length,
        notebooks: affected.notebooks.length,
        compilation: affected.compilation.length,
        programmes: affected.programmes.length,
      },
    });
  }
}
