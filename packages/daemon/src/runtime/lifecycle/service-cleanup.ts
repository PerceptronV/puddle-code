import type { RuntimeServiceCleanupStore } from '../../db/stores/runtime-service-cleanup.js';
import type { RuntimeReconciler } from '../controller/reconcile.js';
import { runtimeBindingIdentity } from '../transport/connections.js';
import { removeRuntimeService } from './supervisor.js';
import { HostAdmission } from '../../host/lifecycle/admission.js';

/** Bounded background registration cleanup, independent of retained data/build collection. */
export class RuntimeServiceCleanup {
  private closed = false;
  private paused = false;
  private readonly admission = new HostAdmission();
  private timer: NodeJS.Timeout | null = null;
  private scheduledAt = 0;
  private active: Promise<void> | null = null;
  private after = '';

  constructor(
    private readonly deps: {
      home: string;
      store: RuntimeServiceCleanupStore;
      reconciler: RuntimeReconciler;
      remove?: typeof removeRuntimeService;
    },
  ) {
    deps.reconciler.on('changed', this.schedule);
    this.schedule();
  }

  private schedule = (): void => {
    if (
      this.closed ||
      this.paused ||
      this.active ||
      (this.timer && this.scheduledAt <= Date.now() + 1000)
    )
      return;
    if (this.timer) clearTimeout(this.timer);
    this.scheduledAt = Date.now() + 1000;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 1000);
    this.timer.unref();
  };

  flush(): Promise<void> {
    if (this.closed || this.paused) return Promise.resolve();
    if (this.active) return this.active;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.active = this.admission.run(() =>
      this.drain()
        .catch(() => {
          // Failed database inspection retains pending ownership/cleanup for a later pass.
        })
        .finally(() => {
          this.active = null;
          if (this.closed || this.paused) return;
          this.scheduledAt = Date.now() + 30_000;
          this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
          }, 30_000);
          this.timer.unref();
        }),
    );
    return this.active;
  }

  private async drain(): Promise<void> {
    let rows = this.deps.store.pending(this.after);
    if (!rows.length && this.after) {
      this.after = '';
      rows = this.deps.store.pending();
    }
    this.after = rows.at(-1)?.runtime_id ?? '';
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, rows.length) }, async () => {
        while (!this.closed && !this.paused && index < rows.length) {
          const row = rows[index++]!;
          try {
            const result = await (this.deps.remove ?? removeRuntimeService)(
              this.deps.home,
              runtimeBindingIdentity(row),
            );
            if (!this.closed && !this.paused && result !== 'owned')
              this.deps.store.complete(row.runtime_id);
          } catch {
            // Failed commands, malformed records and failed commits remain retryable.
          }
        }
      }),
    );
  }

  /** Let an admitted supervisor command settle without committing cleanup during a pause. */
  pause(): ReturnType<HostAdmission['pause']> {
    const hold = this.admission.pause();
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    let released = false;
    return {
      drain: (timeoutMs) => hold.drain(timeoutMs),
      release: () => {
        if (released) return;
        released = true;
        hold.release();
        this.paused = false;
        this.schedule();
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.admission.close();
    this.deps.reconciler.off('changed', this.schedule);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.admission.drain();
  }
}
