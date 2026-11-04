import { join } from 'node:path';
import { runtimeLaunchSchema, runtimeRetiredSchema, type RuntimeLaunch } from '@puddle/shared';
import { acquireHostClaim } from '../../../security/claims.js';
import { readRuntimeJson, runtimeDirectory } from '../../ownership/storage.js';
import { RuntimeHostAllowance } from './allowance.js';
import { HostMemoryLedger } from './ledger.js';
import {
  HOST_MEMORY_CHUNK_BYTES,
  HOST_MEMORY_SPARE_BYTES,
  runtimeEssentialMemoryBytes,
} from './policy.js';

// Strongly retain the OS claim until this process exits. A graceful host.close()
// releases execution ownership while JavaScript buffers may still be reachable.
let processMemoryClaim: ReturnType<typeof acquireHostClaim> | undefined;

export class RuntimeOwnerMemory {
  readonly allowance: RuntimeHostAllowance;
  private timer: NodeJS.Timeout | null = null;
  private retryMs = 1000;
  private closed = false;

  private constructor(
    readonly home: string,
    readonly directory: string,
    readonly launch: RuntimeLaunch,
    readonly claim: ReturnType<typeof acquireHostClaim>,
    private readonly ledger: HostMemoryLedger,
  ) {
    const essential = runtimeEssentialMemoryBytes(Buffer.byteLength(JSON.stringify(launch)));
    const admitted = ledger.readGrant(launch.identity);
    if (!admitted || admitted.bytes < essential)
      throw new Error('Runtime has no complete pre-dispatch memory admission');
    this.allowance = new RuntimeHostAllowance(
      ledger,
      launch.identity,
      HOST_MEMORY_CHUNK_BYTES,
      HOST_MEMORY_SPARE_BYTES,
      () => this.scheduleTrim(),
    );
    // This common state remains charged through process exit. close() must not
    // refund it merely because execution ownership has ended.
    if (!this.allowance.reserve(essential)) throw new Error('Runtime memory admission changed');
  }

  static async open(home: string, id: string): Promise<RuntimeOwnerMemory> {
    if (processMemoryClaim) throw new Error('A runtime process may own only one memory lifetime');
    const directory = runtimeDirectory(home, id);
    const claim = acquireHostClaim(home, `runtime:${id}`);
    let ledger: HostMemoryLedger | null = null;
    try {
      processMemoryClaim = acquireHostClaim(home, `runtime-memory:${id}`);
      const launch = runtimeLaunchSchema.parse(readRuntimeJson(join(directory, 'launch.json')));
      if (launch.identity.runtime_id !== id) throw new Error('Runtime launch identity mismatch');
      try {
        runtimeRetiredSchema.parse(readRuntimeJson(join(directory, 'retired.json')));
        throw new Error('Runtime launch was retired');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      // Sealed opens are concurrent, but an actual SQLite writer can briefly
      // exclude a reader. Retry before consuming launch intent, with no replay.
      const deadline = performance.now() + 5000;
      for (;;) {
        try {
          ledger = HostMemoryLedger.openExisting(home);
          if (!ledger) throw new Error('Host runtime memory accounting is not initialised');
          return new RuntimeOwnerMemory(home, directory, launch, claim, ledger);
        } catch (error) {
          ledger?.close();
          ledger = null;
          if ((error as { code?: string }).code !== 'SQLITE_BUSY' || performance.now() >= deadline)
            throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
      }
    } catch (error) {
      claim.release();
      throw error;
    }
  }

  private scheduleTrim(retry = false): void {
    if (
      this.closed ||
      this.timer ||
      (!retry && this.allowance.availableBytes <= HOST_MEMORY_SPARE_BYTES)
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.closed) return;
      if (this.allowance.trim()) this.retryMs = 1000;
      else {
        this.retryMs = Math.min(30_000, this.retryMs * 2);
        // An uncertain return already reduced locally spendable capacity.
        // Reconcile it even when that local value now looks like idle spare.
        this.scheduleTrim(true);
      }
    }, this.retryMs);
    this.timer.unref();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.allowance.close();
    this.ledger.close();
  }
}
