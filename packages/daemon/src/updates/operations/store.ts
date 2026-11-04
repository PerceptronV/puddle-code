import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  HOST_UPDATE_HISTORY_LIMIT,
  HOST_UPDATE_RECORD_BYTES,
  hostUpdateOperationSchema,
  hostUpdateTargetsSchema,
  hostUpdateTerminal,
  hostStageReceiptSchema,
  type HostUpdateLedger,
  type HostUpdateOperation,
  type HostUpdateTargets,
  type HostStageReceipt,
} from '@puddle/shared';
import {
  atomicPrivateJson,
  initialisePrivateHome,
  privateDirectory,
  syncPrivateDirectory,
} from '@puddle/shared/node';
import {
  readHostUpdateLedger,
  validateHostUpdateLedger,
  requireNoHostRemoval,
} from '@puddle/shared/node/host-control';
import { acquireHostClaim } from '../../security/claims.js';

type Reference = Pick<HostUpdateOperation, 'id' | 'revision'>;
type Phase = HostUpdateOperation['phase'];
const controlScope = 'host-update-control';
const executionScope = 'host-update-execution';

export class HostUpdateConflict extends Error {
  constructor(
    message: string,
    readonly operation: HostUpdateOperation | null,
  ) {
    super(message);
    this.name = 'HostUpdateConflict';
  }
}

interface Options {
  now?: () => number;
  /** Fault injection at the durable commit boundary; production uses atomicPrivateJson. */
  write?: typeof atomicPrivateJson;
}

/** One durable host operation, with bounded history and no application DB ownership. */
export class HostUpdateOperations {
  private readonly file: string;
  private readonly now: () => number;
  private readonly write: typeof atomicPrivateJson;
  constructor(
    private readonly home: string,
    options: Options = {},
  ) {
    initialisePrivateHome(home);
    privateDirectory(join(home, 'updates'));
    // Persist the new directory entry as well as each later ledger replacement.
    syncPrivateDirectory(home);
    this.file = join(home, 'updates', 'operations.json');
    this.now = options.now ?? Date.now;
    this.write = options.write ?? atomicPrivateJson;
  }

  read(id?: string): HostUpdateOperation | null {
    if (id !== undefined) hostUpdateOperationSchema.shape.id.parse(id);
    const ledger = this.load();
    if (id === undefined || ledger.current?.id === id) return ledger.current;
    return ledger.history.find((operation) => operation.id === id) ?? null;
  }

  /** Coalesce concurrent requests; an uncertain caller observes the returned id. */
  begin(input: HostUpdateTargets): { operation: HostUpdateOperation; created: boolean } {
    const targets = hostUpdateTargetsSchema
      .parse(input)
      .sort((a, b) => a.component.localeCompare(b.component));
    return this.locked(() => {
      const ledger = this.load();
      if (ledger.current && !hostUpdateTerminal(ledger.current.phase)) {
        if (JSON.stringify(ledger.current.targets) !== JSON.stringify(targets))
          throw new HostUpdateConflict('Another host update is in progress', ledger.current);
        return { operation: ledger.current, created: false };
      }
      // A completed worker may still be closing its resources. Do not overlap it.
      const execution = acquireHostClaim(this.home, executionScope);
      try {
        const now = this.now();
        const operation = hostUpdateOperationSchema.parse({
          format: 1,
          id: randomUUID(),
          revision: 1,
          created_at: now,
          updated_at: now,
          phase: 'checking',
          targets,
          stages: [],
          preflight: null,
          approved: null,
          dispatch_id: null,
          worker_id: null,
          verification: null,
          message: null,
        });
        if (ledger.current) ledger.history.push(ledger.current);
        ledger.history = ledger.history.slice(-HOST_UPDATE_HISTORY_LIMIT);
        ledger.current = operation;
        this.save(ledger);
        return { operation, created: true };
      } finally {
        execution.release();
      }
    });
  }

  downloading(reference: Reference): HostUpdateOperation {
    return this.change(reference, ['checking'], (operation) => ({
      ...operation,
      phase: 'downloading',
    }));
  }

  staged(reference: Reference, input: HostStageReceipt): HostUpdateOperation {
    const receipt = hostStageReceiptSchema.parse(input);
    return this.change(reference, ['checking', 'downloading'], (operation) => {
      if (operation.stages.some((stage) => stage.record.component === receipt.record.component))
        throw new HostUpdateConflict('This component already has an exact stage', operation);
      const stages = [...operation.stages, receipt].sort((a, b) =>
        a.record.component.localeCompare(b.record.component),
      );
      return {
        ...operation,
        stages,
        phase: stages.length === operation.targets.length ? 'staged' : 'downloading',
      };
    });
  }

  preflight(reference: Reference, fingerprint: string): HostUpdateOperation {
    return this.change(reference, ['staged', 'preflight', 'approved'], (operation) => ({
      ...operation,
      phase: 'preflight',
      preflight: fingerprint,
      approved: null,
      message: null,
    }));
  }

  /** Called only after the coordinator has checked host authority and exact impact. */
  approve(reference: Reference, fingerprint: string): HostUpdateOperation {
    return this.change(reference, ['preflight'], (operation) => {
      if (operation.preflight !== fingerprint)
        throw new HostUpdateConflict('Update impact changed before approval', operation);
      return { ...operation, phase: 'approved', approved: fingerprint };
    });
  }

  /** Persist before the one external supervisor dispatch; repeats cannot dispatch again. */
  dispatch(reference: Reference): HostUpdateOperation {
    return this.change(reference, ['approved'], (operation) => ({
      ...operation,
      phase: 'dispatching',
      dispatch_id: randomUUID(),
    }));
  }

  stopBeforeDispatch(
    reference: Reference,
    phase: 'blocked' | 'cancelled' | 'superseded' | 'failed',
    message: string,
  ): HostUpdateOperation {
    return this.change(
      reference,
      ['checking', 'downloading', 'staged', 'preflight', 'approved'],
      (operation) => ({ ...operation, phase, message }),
    );
  }

  /** Hold across execution. A crash releases the lock, but never resets consumption. */
  claimExecution(reference: Reference, dispatchId: string, preflight: string) {
    const claim = acquireHostClaim(this.home, executionScope);
    let current: HostUpdateOperation;
    try {
      current = this.change(reference, ['dispatching'], (operation) => {
        if (
          operation.dispatch_id !== dispatchId ||
          operation.approved !== preflight ||
          operation.worker_id !== null
        )
          throw new HostUpdateConflict(
            'Update worker does not match its approved dispatch',
            operation,
          );
        return { ...operation, phase: 'applying', worker_id: randomUUID() };
      });
    } catch (error) {
      claim.release();
      throw error;
    }
    let released = false;
    const advance = (allowed: Phase[], phase: Phase, fields: Partial<HostUpdateOperation> = {}) => {
      if (released) throw new Error('Update execution claim is released');
      current = this.change(current, allowed, (operation) => ({ ...operation, ...fields, phase }));
      return structuredClone(current);
    };
    return {
      get operation() {
        return structuredClone(current);
      },
      verifying: () => advance(['applying'], 'verifying'),
      complete: (verification: string) =>
        advance(['verifying'], 'complete', { verification, message: null }),
      failed: (message: string) =>
        advance(['applying', 'verifying'], 'recovery_required', { message }),
      release() {
        if (!released) {
          released = true;
          claim.release();
        }
      },
    };
  }

  /** Explicit inspection fences an unstarted job or records loss after execution began. */
  requireRecovery(reference: Reference, message: string): HostUpdateOperation {
    const claim = acquireHostClaim(this.home, executionScope);
    try {
      return this.change(reference, ['dispatching', 'applying', 'verifying'], (operation) => ({
        ...operation,
        phase: 'recovery_required',
        message,
      }));
    } finally {
      claim.release();
    }
  }

  /** Fence the old dispatch and hold exclusion throughout explicit recovery verification. */
  claimRecovery(reference: Reference) {
    const claim = acquireHostClaim(this.home, executionScope);
    let current: HostUpdateOperation;
    try {
      current = this.change(
        reference,
        ['dispatching', 'applying', 'verifying', 'recovery_required'],
        (operation) => ({
          ...operation,
          phase: 'recovery_required',
          message: operation.message ?? 'Completion requires recovery verification',
        }),
      );
    } catch (error) {
      claim.release();
      throw error;
    }
    let released = false;
    return {
      get operation() {
        return structuredClone(current);
      },
      complete: (verification: string) => {
        if (released) throw new Error('Recovery execution claim is released');
        current = this.change(current, ['recovery_required'], (operation) => ({
          ...operation,
          phase: 'complete',
          verification,
          message: null,
        }));
        return structuredClone(current);
      },
      release() {
        if (released) return;
        released = true;
        claim.release();
      },
    };
  }

  /** The coordinator supplies positive adoption or rollback evidence; never a timeout. */
  resolveRecovery(
    reference: Reference,
    phase: 'complete' | 'rolled_back',
    verification: string,
  ): HostUpdateOperation {
    const claim = acquireHostClaim(this.home, executionScope);
    try {
      return this.change(reference, ['recovery_required'], (operation) => ({
        ...operation,
        phase,
        verification,
        message: null,
      }));
    } finally {
      claim.release();
    }
  }

  private change(
    reference: Reference,
    allowed: Phase[],
    update: (operation: HostUpdateOperation) => HostUpdateOperation,
  ): HostUpdateOperation {
    return this.locked(() => {
      const ledger = this.load();
      const current = ledger.current;
      if (
        !current ||
        current.id !== reference.id ||
        current.revision !== reference.revision ||
        !allowed.includes(current.phase)
      )
        throw new HostUpdateConflict(
          'Host update state changed; inspect the operation before continuing',
          current,
        );
      const next = update(current);
      next.revision = current.revision + 1;
      next.updated_at = Math.max(current.updated_at, this.now());
      ledger.current = next;
      this.save(ledger);
      return structuredClone(next);
    });
  }

  private locked<T>(action: () => T): T {
    const claim = acquireHostClaim(this.home, controlScope);
    try {
      requireNoHostRemoval(this.home);
      return action();
    } finally {
      claim.release();
    }
  }

  private load(): HostUpdateLedger {
    return readHostUpdateLedger(this.home);
  }

  private save(ledger: HostUpdateLedger): void {
    const valid = validateHostUpdateLedger(ledger);
    if (Buffer.byteLength(JSON.stringify(valid)) > HOST_UPDATE_RECORD_BYTES)
      throw new Error('Host update ledger exceeds its limit');
    this.write(this.file, valid, { syncDirectory: true });
  }
}
