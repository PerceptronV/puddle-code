import { join } from 'node:path';
import { hostUpdateTerminal, type RuntimeControllerRecord } from '@puddle/shared';
import { readHostBootIdentity } from '@puddle/shared/node/host-control';
import {
  runCompilationCommand,
  type CompilationCommandRunner,
} from '../../../compilation/process.js';
import type { RuntimeStore } from '../../../db/stores/runtimes.js';
import type { RuntimeLogRetention } from '../../../storage/runtime-retention/compaction.js';
import { CollectionBudget } from './budget.js';
import { OnlineCollectionGuard } from './guard.js';
import { withReleaseCollectionExclusion } from './exclusion.js';
import {
  executeReleaseCollection,
  inspectReleaseCollection,
  prepareReleaseCollection,
} from './execute.js';
import { reviewReleaseCollection } from './review.js';
import { collectionOperations } from './retirement/operations.js';
import { retireRuntimeRelease } from './retirement/runtimes.js';
import { retireUpdateRelease } from './retirement/updates.js';

export const RELEASE_COLLECTION_MAINTENANCE = {
  deadlineMs: 5000,
  startupMs: 30_000,
  minimumMs: 5 * 60_000,
  intervalMs: 30 * 60_000,
  retirements: 8,
} as const;
type Runtimes = Pick<RuntimeStore, 'releaseReferences' | 'get'>;
interface Dependencies {
  home: string;
  runtimes: Runtimes;
  pause(timeoutMs?: number): Promise<{ release(): void }>;
  controller(): Pick<RuntimeControllerRecord, 'id' | 'epoch'> | null;
  /** One bounded committed result-reclamation batch; true requests another slow pass. */
  reclaimResults?(): boolean;
  runtimeLogs?: Pick<RuntimeLogRetention, 'sweep' | 'close'>;
  /** Reinspect already-ended owners using their original final journal and retirement claims. */
  retireRuntimeResults?(id: string): boolean;
  run?: CompilationCommandRunner;
  onError?(error: unknown): void;
  /** Isolated tests supply kernel observations; production always reads the kernel. */
  boot?: typeof readHostBootIdentity;
}

/** Optional reclamation never delays readiness. Runs outside the upkeep it pauses. */
export class ReleaseCollectionMaintenance {
  private closed = false;
  private timer: NodeJS.Timeout | null = null;
  private scheduledAt = 0;
  private lastStarted = -Infinity;
  private active: Promise<void> | null = null;
  private requested = false;
  private runtimeAfter = '';
  private updateAfter = '';
  constructor(private readonly deps: Dependencies) {
    this.schedule(RELEASE_COLLECTION_MAINTENANCE.startupMs);
  }

  /** Coalesce notifications without postponing an earlier scheduled pass. */
  request = (): void => {
    if (this.closed) return;
    this.requested = true;
    if (!this.active)
      this.schedule(
        Math.max(
          1000,
          this.lastStarted + RELEASE_COLLECTION_MAINTENANCE.minimumMs - performance.now(),
        ),
      );
  };
  private schedule(delay: number): void {
    if (this.closed) return;
    const at = performance.now() + delay;
    if (this.timer && this.scheduledAt <= at) return;
    if (this.timer) clearTimeout(this.timer);
    this.scheduledAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
    this.timer.unref();
  }
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.active) return this.active;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.requested = false;
    this.lastStarted = performance.now();
    this.active = this.pass()
      .catch((error) => this.deps.onError?.(error))
      .finally(() => {
        this.active = null;
        this.schedule(
          this.requested
            ? RELEASE_COLLECTION_MAINTENANCE.minimumMs
            : RELEASE_COLLECTION_MAINTENANCE.intervalMs,
        );
      });
    return this.active;
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.active;
    await this.deps.runtimeLogs?.close();
  }
  private async pass(): Promise<void> {
    const deadline = performance.now() + RELEASE_COLLECTION_MAINTENANCE.deadlineMs;
    const current = () => {
      if (this.closed || performance.now() >= deadline)
        throw new Error('Collection maintenance ended');
    };
    const budget = new CollectionBudget();
    budget.record(join(this.deps.home, 'updates/operations.json'));
    const guard = new OnlineCollectionGuard(this.deps.home, this.deps.controller, current);
    let pause: Awaited<ReturnType<Dependencies['pause']>> | undefined;
    try {
      const boot = await (this.deps.boot ?? readHostBootIdentity)();
      current();
      pause = await this.deps.pause(deadline - performance.now());
      guard.requireController();
      const run: CompilationCommandRunner = guard.commands(async (command) => {
        current();
        const result = await (this.deps.run ?? runCompilationCommand)({
          ...command,
          timeoutMs: Math.max(
            1,
            Math.min(
              command.timeoutMs ?? RELEASE_COLLECTION_MAINTENANCE.deadlineMs,
              deadline - performance.now(),
            ),
          ),
        });
        current();
        return result;
      });
      await withReleaseCollectionExclusion(
        guard,
        () => !this.closed,
        async (requireCurrent) => {
          requireCurrent();
          if (this.deps.reclaimResults?.()) this.requested = true;
          let rows = this.deps.runtimes.releaseReferences(
            this.runtimeAfter,
            RELEASE_COLLECTION_MAINTENANCE.retirements,
          );
          if (!rows.length && this.runtimeAfter) {
            this.runtimeAfter = '';
            rows = this.deps.runtimes.releaseReferences(
              '',
              RELEASE_COLLECTION_MAINTENANCE.retirements,
            );
          }
          for (const row of rows) {
            requireCurrent();
            this.runtimeAfter = row.runtime_id;
            budget.entry();
            try {
              if (this.deps.retireRuntimeResults?.(row.runtime_id)) this.requested = true;
            } catch (error) {
              this.deps.onError?.(error);
            }
            if (!boot) continue;
            try {
              await retireRuntimeRelease(
                this.deps.home,
                this.deps.runtimes,
                row.runtime_id,
                boot,
                requireCurrent,
                run,
                budget,
              );
            } catch (error) {
              this.deps.onError?.(error);
            }
          }
          requireCurrent();
          if (
            await this.deps.runtimeLogs?.sweep(
              requireCurrent,
              Math.min(deadline, performance.now() + 1000),
              budget,
            )
          )
            this.requested = true;
          const { operations, protectedIds } = await collectionOperations(
            this.deps.home,
            requireCurrent,
            budget,
          );
          const eligible = [...operations.values()]
            .filter(
              (operation) => !protectedIds.has(operation.id) && hostUpdateTerminal(operation.phase),
            )
            .sort((a, b) => a.id.localeCompare(b.id));
          let updates = eligible
            .filter(({ id }) => id > this.updateAfter)
            .slice(0, RELEASE_COLLECTION_MAINTENANCE.retirements);
          if (!updates.length) {
            this.updateAfter = '';
            updates = eligible.slice(0, RELEASE_COLLECTION_MAINTENANCE.retirements);
          }
          for (const operation of updates) {
            requireCurrent();
            this.updateAfter = operation.id;
            try {
              await retireUpdateRelease(this.deps.home, operation, requireCurrent, run, budget);
            } catch (error) {
              this.deps.onError?.(error);
            }
          }
        },
      );
      current();
      let batch = inspectReleaseCollection(guard);
      if (!batch || batch.actions.every(({ state }) => state === 'finished')) {
        const review = await reviewReleaseCollection(
          guard,
          this.deps.runtimes,
          () => !this.closed,
          Date.now(),
          budget,
        );
        if (!review.candidates.length) return;
        batch = await prepareReleaseCollection(
          guard,
          this.deps.runtimes,
          review.fingerprint,
          () => !this.closed,
          { budget },
        );
      }
      if (batch)
        await executeReleaseCollection(guard, this.deps.runtimes, batch.id, () => !this.closed, {
          budget,
        });
    } finally {
      try {
        pause?.release();
      } finally {
        guard.release();
      }
    }
  }
}
