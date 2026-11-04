import type { AgentNotification, NotificationContent, Session } from '@puddle/shared';
import type {
  RuntimeAttentionStore,
  PendingRuntimeAttention,
} from '../db/stores/runtime-attention.js';
import type { RuntimeStore } from '../db/stores/runtimes.js';
import type { SessionStore } from '../db/stores/sessions.js';
import { notificationSnippet } from '../sessions/notification-content.js';
import type { RuntimeReconciler } from './reconcile.js';

/** Older conditions remain inspectable, but never become a backlog of toasts/pushes. */
export const RUNTIME_ATTENTION_MAX_AGE_MS = 5 * 60_000;

export class RuntimeNotifications {
  private closed = false;
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private retryMs = 0;
  private after = '';
  constructor(
    private readonly deps: {
      store: RuntimeAttentionStore;
      runtimes: RuntimeStore;
      sessions: SessionStore;
      reconciler: RuntimeReconciler;
      ready(runtimeId: string): boolean;
      content(session: Session, row: PendingRuntimeAttention): Promise<NotificationContent>;
      emit(event: AgentNotification): void;
    },
  ) {
    deps.reconciler.on('changed', this.schedule);
    this.schedule();
  }

  private schedule = (): void => {
    if (this.closed || this.timer || this.active) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.retryMs || 25);
    this.timer.unref();
  };

  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.drain()
      .then(
        () => {
          this.retryMs = 0;
        },
        () => {
          this.retryMs = Math.min(this.retryMs ? this.retryMs * 2 : 1000, 30_000);
        },
      )
      .finally(() => {
        this.active = null;
        if (this.closed) return;
        try {
          if (this.deps.store.pending().length) {
            this.retryMs ||= 1000;
            this.schedule();
          }
        } catch {
          this.retryMs = Math.min(this.retryMs ? this.retryMs * 2 : 1000, 30_000);
          this.schedule();
        }
      });
    return this.active;
  }

  private current(row: PendingRuntimeAttention): Session | null {
    const age = Date.now() - Date.parse(row.attention.created_at);
    const owner = this.deps.runtimes.selectedOwner(row.sessionId);
    if (
      age < 0 ||
      age > RUNTIME_ATTENTION_MAX_AGE_MS ||
      !owner ||
      owner.runtime_id !== row.runtimeId ||
      owner.active_session_id !== row.sessionId ||
      owner.active_segment_id !== row.attention.segment_id ||
      !['running', 'exited', 'failed'].includes(owner.state) ||
      this.deps.runtimes.stopRequested(row.runtimeId)
    )
      return null;
    const session = this.deps.sessions.get(row.sessionId);
    return session.status === row.attention.reason ? session : null;
  }

  private async drain(): Promise<void> {
    let pending = this.deps.store.pending(this.after);
    if (!pending.length && this.after) {
      this.after = '';
      pending = this.deps.store.pending();
    }
    // Unavailable owners must not permanently occupy the first bounded page.
    this.after = pending.at(-1)?.runtimeId ?? '';
    let index = 0;
    const worker = async () => {
      while (!this.closed && index < pending.length) {
        const row = pending[index++]!;
        if (!this.deps.ready(row.runtimeId)) continue;
        const session = this.current(row);
        if (!session) {
          this.deps.store.claim(row);
          continue;
        }
        let content: NotificationContent;
        try {
          content = await this.deps.content(session, row);
        } catch {
          content = {
            title:
              notificationSnippet(
                session.title ?? session.agent_title ?? session.osc_title ?? session.id.slice(0, 8),
              ).slice(0, 160) || 'Puddle',
            body:
              row.attention.reason === 'exited'
                ? 'Agent finished running'
                : 'Waiting for your input',
            project: session.project_id,
            session: session.id,
          };
        }
        if (this.closed) return;
        if (!this.deps.ready(row.runtimeId)) continue;
        const current = this.current(row);
        if (!this.deps.store.claim(row) || !current) continue;
        this.deps.emit({
          t: 'agent-notification',
          id: row.attention.id,
          session: session.id,
          reason: row.attention.reason,
          content,
        });
      }
    };
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(4, pending.length) }, worker),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  close(): void {
    this.closed = true;
    this.deps.reconciler.off('changed', this.schedule);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Outstanding bounded preview reads cannot access the database or emit after close.
  }
}
