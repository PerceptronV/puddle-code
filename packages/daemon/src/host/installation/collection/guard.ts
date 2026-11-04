import { realpathSync } from 'node:fs';
import { hostUpdateTerminal, type RuntimeControllerRecord } from '@puddle/shared';
import { readHostUpdateLedger, requireNoHostRemoval } from '@puddle/shared/node/host-control';
import { acquireHostClaim } from '../../../security/claims.js';
import { readRuntimeController } from '../../../runtime/ownership/storage.js';
import {
  runCompilationCommand,
  type CompilationCommandRunner,
} from '../../../compilation/process.js';
import { acquireInstallationLock } from '../lock.js';

export interface ReleaseCollectionGuard {
  readonly home: string;
  requireController(): void;
}
type Identity = Pick<RuntimeControllerRecord, 'id' | 'epoch'>;

/** Borrow the paused daemon's existing controller; never acquire it or advance its epoch. */
export class OnlineCollectionGuard implements ReleaseCollectionGuard {
  private active = true;
  private readonly claims: Array<{ release(): void }> = [];
  private installation?: ReturnType<typeof acquireInstallationLock>;
  private readonly canonical: string;
  private identity: Identity | null = null;
  constructor(
    readonly home: string,
    private readonly controller: () => Identity | null,
    private readonly current: () => void,
  ) {
    this.canonical = realpathSync(home);
    try {
      current();
      this.claims.push(acquireHostClaim(home, 'host-update-coordinator'));
      this.claims.push(acquireHostClaim(home, 'host-update-execution'));
      this.installation = acquireInstallationLock(home);
      requireNoHostRemoval(home);
      const ledger = readHostUpdateLedger(home);
      if (
        [ledger.current, ...ledger.history].some(
          (operation) => operation && !hostUpdateTerminal(operation.phase),
        )
      )
        throw new Error('Host update remains unresolved');
      this.identity = controller();
      this.requireController();
    } catch (error) {
      this.release();
      throw error;
    }
  }
  requireController(): void {
    this.current();
    const current = this.controller();
    const record = readRuntimeController(this.home);
    if (
      !this.active ||
      realpathSync(this.home) !== this.canonical ||
      !this.identity ||
      !current ||
      current.id !== this.identity.id ||
      current.epoch !== this.identity.epoch ||
      !record.active ||
      record.id !== current.id ||
      record.epoch !== current.epoch
    )
      throw new Error('Collection controller changed');
  }
  commands(run: CompilationCommandRunner = runCompilationCommand): CompilationCommandRunner {
    return (command) => {
      this.requireController();
      return run({
        ...command,
        inheritedFds: [...(command.inheritedFds ?? []), this.installation!.descriptor],
      });
    };
  }
  release(): void {
    if (!this.active) return;
    this.active = false;
    try {
      this.installation?.release();
    } finally {
      for (const claim of this.claims.reverse()) claim.release();
    }
  }
}
