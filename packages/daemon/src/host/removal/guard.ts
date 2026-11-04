import { realpathSync } from 'node:fs';
import { hostUpdateTerminal } from '@puddle/shared';
import { readHostUpdateLedger } from '@puddle/shared/node/host-control';
import { runCompilationCommand, type CompilationCommandRunner } from '../../compilation/process.js';
import { acquireHostClaim } from '../../security/claims.js';
import { requireEndedUpdateWorker } from '../../updates/worker/lifetime.js';
import { readUpdateWorker } from '../../updates/worker/supervisor.js';
import { requireEndedUpdateRecoveryWorkers } from '../../updates/recovery/worker/records.js';
import { acquireInstallationLock } from '../installation/lock.js';
import { acquireRuntimeController } from '../../runtime/ownership/storage.js';

/** Retain exclusion across supervisor shutdown, offline disposition and final file handling. */
export class HostRemovalGuard {
  private active = true;
  private controlling = false;
  private readonly canonicalHome: string;
  private constructor(
    readonly home: string,
    private readonly claims: Array<{ release(): void }>,
    private readonly installation: ReturnType<typeof acquireInstallationLock>,
  ) {
    this.canonicalHome = realpathSync(home);
  }

  static acquire(home: string): HostRemovalGuard {
    const claims: Array<{ release(): void }> = [];
    let installation: ReturnType<typeof acquireInstallationLock> | undefined;
    try {
      claims.push(acquireHostClaim(home, 'host-update-coordinator'));
      claims.push(acquireHostClaim(home, 'host-update-execution'));
      installation = acquireInstallationLock(home);
      // Preserve the configured spelling used by installed service arguments.
      const guard = new HostRemovalGuard(home, claims, installation);
      guard.requireHeld(home);
      return guard;
    } catch (error) {
      installation?.release();
      for (const claim of claims.reverse()) claim.release();
      throw error;
    }
  }

  requireHeld(home = this.home): void {
    if (
      !this.active ||
      realpathSync(home) !== this.canonicalHome ||
      realpathSync(this.home) !== this.canonicalHome
    )
      throw new Error('Host removal exclusion is no longer held for this home');
    const ledger = readHostUpdateLedger(this.home);
    for (const operation of [ledger.current, ...ledger.history]) {
      if (!operation) continue;
      if (!hostUpdateTerminal(operation.phase))
        throw new Error('Resolve the host update before removal');
      if (operation.worker_id) {
        requireEndedUpdateWorker(this.home, readUpdateWorker(this.home, operation.id), operation);
        requireEndedUpdateRecoveryWorkers(this.home, operation);
      }
    }
  }

  /** Children retain installer exclusion if this participating process is killed. */
  commands(run: CompilationCommandRunner = runCompilationCommand): CompilationCommandRunner {
    return (command) => {
      this.requireHeld();
      return run({
        ...command,
        inheritedFds: [...(command.inheritedFds ?? []), this.installation.descriptor],
      });
    };
  }

  acquireController(): ReturnType<typeof acquireRuntimeController> {
    this.requireHeld();
    if (this.controlling) throw new Error('Host removal already owns the controller');
    const controller = acquireRuntimeController(this.home);
    this.controlling = true;
    let released = false;
    return {
      record: controller.record,
      release: () => {
        if (released) return;
        released = true;
        try {
          controller.release();
        } finally {
          this.controlling = false;
        }
      },
    };
  }

  requireController(): void {
    this.requireHeld();
    if (!this.controlling) throw new Error('Host removal does not own the runtime controller');
  }

  release(): void {
    if (!this.active) return;
    if (this.controlling)
      throw new Error('Drain the removal controller before releasing host exclusion');
    this.active = false;
    try {
      this.installation.release();
    } finally {
      for (const claim of this.claims.reverse()) claim.release();
    }
  }
}
