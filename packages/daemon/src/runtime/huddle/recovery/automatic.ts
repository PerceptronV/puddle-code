import { HUDDLE_AUTOMATIC_RECOVERY_LIMIT } from '@puddle/shared';
import { readHostBootIdentity } from '@puddle/shared/node/host-control';
import type { RuntimeStore } from '../../../db/stores/runtimes.js';
import type { SessionStore } from '../../../db/stores/sessions.js';
import type { ProjectStore } from '../../../db/stores/projects.js';
import type { StorageMonitor } from '../../../storage/monitor.js';
import { HostAdmission } from '../../../host/lifecycle/admission.js';
import type { RuntimeReconciler } from '../../controller/reconcile.js';
import type { RuntimeLauncher } from '../../lifecycle/launcher.js';
import { huddleBindingLaunch } from '../ownership/binding.js';
import { readRecordedHuddleControl } from '../state/readers/activation.js';
import { hasHuddleContainment } from './containment.js';
import { huddleRecoveryPlacementAvailable } from './placement.js';

/** Reuses authoritative owner-loss reconciliation; never detects agent status or signals a PID. */
export class HuddleCrashRecovery {
  private readonly admission = new HostAdmission();
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private started = false;
  private closed = false;
  private paused = false;
  private dirty = false;
  private retry = false;
  private readonly observed = () => {
    this.dirty = true;
    this.schedule(1000);
  };
  constructor(
    private readonly deps: {
      home: string;
      runtimes: Pick<RuntimeStore, 'huddleStartupCandidates' | 'get' | 'stopRequested'>;
      sessions: Pick<SessionStore, 'get'>;
      projects: Pick<ProjectStore, 'get'>;
      reconciler: Pick<RuntimeReconciler, 'on' | 'off'>;
      launcher: Pick<RuntimeLauncher, 'recoverHuddle'>;
      storage?: Pick<StorageMonitor, 'assertAdmission'>;
      failed(id: string, error: unknown): void;
    },
  ) {
    deps.reconciler.on('huddle-owner-lost', this.observed);
  }

  /** Start only after normal owner adoption, service readiness and reboot recovery. */
  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.schedule(0);
  }
  private schedule(delay: number) {
    if (!this.started || this.closed || this.paused || this.active || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dirty = false;
      this.retry = false;
      this.active = this.admission
        .run(() => this.scan())
        .catch((error: unknown) => {
          this.retry = true;
          this.deps.failed('discovery', error);
        })
        .finally(() => {
          this.active = null;
          if (this.dirty || this.retry) this.schedule(this.dirty ? 1000 : 30_000);
        });
    }, delay);
    this.timer.unref();
  }
  private async scan() {
    const boot = await readHostBootIdentity();
    if (!boot) return;
    let after = '';
    while (!this.closed && !this.paused) {
      const candidates = this.deps.runtimes.huddleStartupCandidates(after);
      if (!candidates.length) return;
      for (const binding of candidates) {
        after = binding.runtime_id;
        if (this.closed || this.paused) return;
        // Only existing reconciliation may turn an absent owner into interrupted authority.
        if (binding.state !== 'interrupted') continue;
        try {
          const source = huddleBindingLaunch(this.deps.home, binding);
          if (
            source.boot_id !== boot ||
            source.capabilities.automaticRecovery !== 1 ||
            (source.recovery?.automaticAttempts ?? 0) >= HUDDLE_AUTOMATIC_RECOVERY_LIMIT ||
            !hasHuddleContainment(this.deps.home, source)
          )
            continue;
          const valid = () => {
            const current = this.deps.runtimes.get(binding.runtime_id);
            return (
              !this.closed &&
              !this.paused &&
              current?.state === 'interrupted' &&
              current.incarnation === binding.incarnation &&
              current.active_session_id === binding.active_session_id &&
              huddleRecoveryPlacementAvailable(this.deps, binding)
            );
          };
          if (!valid() || readRecordedHuddleControl(this.deps.home, source.scope).state !== 'armed')
            continue;
          // A live descendant, held claim or temporary capacity failure can be observed again.
          // Once replacement intent commits, this predecessor is exited and cannot be retried.
          this.retry = true;
          await this.deps.storage?.assertAdmission([
            this.deps.home,
            binding.canonical_worktree_path,
          ]);
          if (!valid()) continue;
          await this.deps.launcher.recoverHuddle(
            binding.active_session_id,
            { runtimeId: binding.runtime_id, incarnation: binding.incarnation },
            valid,
            { after: 'owner-crash', automatic: true },
          );
        } catch (error) {
          this.deps.failed(binding.active_session_id, error);
        }
      }
    }
  }

  pause(): ReturnType<HostAdmission['pause']> {
    const hold = this.admission.pause();
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    let released = false;
    return {
      drain: (timeout) => hold.drain(timeout),
      release: () => {
        if (released) return;
        released = true;
        hold.release();
        this.paused = false;
        this.schedule(0);
      },
    };
  }
  async close() {
    this.closed = true;
    this.admission.close();
    this.deps.reconciler.off('huddle-owner-lost', this.observed);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.admission.drain();
  }
}
