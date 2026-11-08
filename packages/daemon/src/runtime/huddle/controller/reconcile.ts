import { EventEmitter } from 'node:events';
import type { SessionStatus } from '@puddle/shared';
import type { RuntimeStore } from '../../../db/stores/runtimes.js';
import type { SessionStore } from '../../../db/stores/sessions.js';
import type { EventStore } from '../../../db/stores/events.js';
import type { Db } from '../../../db/db.js';
import { HostAdmission } from '../../../host/lifecycle/admission.js';
import type { HuddleOwnerClient } from '../transport/client.js';
import { retireMissingHuddle } from './discovery.js';
import { huddleBindingLaunch, requireHuddleState } from '../ownership/binding.js';

interface Attachment {
  client: HuddleOwnerClient;
  active: Promise<void> | null;
  dirty: boolean;
  failed: boolean;
  disconnected: boolean;
  timer: NodeJS.Timeout | null;
  retry: number;
  changed: () => void;
}

/** Projection only: never sends Run, arms triggers or retries a mutation. */
export class HuddleReconciler extends EventEmitter {
  private readonly entries = new Map<string, Attachment>();
  private readonly admission = new HostAdmission();
  private closed = false;
  private paused = false;
  constructor(
    private readonly deps: {
      home: string;
      db: Db;
      runtimes: RuntimeStore;
      sessions: SessionStore;
      events: EventStore;
    },
  ) {
    super();
  }
  async attach(id: string, client: HuddleOwnerClient): Promise<void> {
    const previous = this.entries.get(id);
    if (previous && !previous.disconnected) throw new Error('Huddle is already attached');
    await previous?.active;
    this.admission.assertOpen();
    const entry: Attachment = {
      client,
      active: null,
      dirty: false,
      failed: true,
      disconnected: false,
      timer: null,
      retry: 0,
      changed: () => {},
    };
    entry.changed = () => {
      entry.dirty = true;
      this.schedule(id, entry);
    };
    this.entries.set(id, entry);
    client.on('changed', entry.changed);
    client.once('disconnected', () => {
      entry.disconnected = true;
      entry.failed = true;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      client.off('changed', entry.changed);
    });
    await this.refresh(id);
  }
  pendingIds(): string[] {
    return [...this.entries].filter(([, e]) => e.failed).map(([id]) => id);
  }
  settled(id: string): boolean {
    const entry = this.entries.get(id);
    return (
      !this.closed &&
      !this.paused &&
      !!entry &&
      !(entry.active || entry.dirty || entry.failed || entry.disconnected)
    );
  }
  refresh(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || this.closed || this.paused)
      return Promise.reject(new Error('Huddle observation is unavailable'));
    if (entry.active) {
      entry.dirty = true;
      return entry.active;
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.dirty = false;
    entry.active = this.admission
      .run(async () => {
        try {
          const response = await entry.client.request({ t: 'inspect' });
          if (this.closed || this.paused || entry.disconnected) return;
          if (response.t !== 'state') throw new Error('Huddle omitted its state');
          const binding = this.deps.runtimes.get(id);
          if (!binding) throw new Error('Huddle binding disappeared');
          requireHuddleState(huddleBindingLaunch(this.deps.home, binding), response.state);
          const state = response.state;
          const status: SessionStatus =
            state.failure || state.control.state === 'interrupted'
              ? 'interrupted'
              : state.state === 'exited' || state.control.state === 'stopped'
                ? 'exited'
                : 'running';
          const changed = this.deps.runtimes.observeHuddle(id, state, () =>
            this.deps.sessions.setStatus(binding.active_session_id, status),
          );
          entry.failed = false;
          entry.retry = 0;
          if (changed) this.publish(id);
        } catch {
          entry.failed = true;
          entry.dirty = true;
          entry.retry = Math.min(entry.retry ? entry.retry * 2 : 1000, 30_000);
        }
      })
      .finally(() => {
        entry.active = null;
        if (entry.dirty) this.schedule(id, entry);
      });
    return entry.active;
  }
  private schedule(id: string, entry: Attachment) {
    if (this.closed || this.paused || entry.disconnected || entry.active || entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.refresh(id);
    }, entry.retry || 25);
    entry.timer.unref();
  }
  async retire(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (entry && !entry.disconnected) return false;
    await entry?.active;
    if (this.closed || this.paused) return false;
    const binding = this.deps.runtimes.get(id);
    if (!binding) return false;
    const retired = retireMissingHuddle(this.deps.home, binding, (state, clean) => {
      const apply = () => {
        this.deps.sessions.setStatus(binding.active_session_id, clean ? 'exited' : 'interrupted');
        this.deps.events.record(binding.active_session_id, clean ? 'exited' : 'interrupted', {
          reason: clean ? 'huddle_stopped' : 'huddle_owner_lost',
        });
      };
      this.deps.db.transaction(() => {
        if (state) this.deps.runtimes.observeHuddle(id, state, () => {});
        if (clean) this.deps.runtimes.finish(id, 'exited', apply);
        else this.deps.runtimes.interrupt(id, apply);
      })();
    });
    if (retired) {
      if (entry?.timer) clearTimeout(entry.timer);
      this.entries.delete(id);
      this.publish(id);
      if (this.deps.runtimes.get(id)?.state === 'interrupted') this.emit('owner-lost', id);
    }
    return retired;
  }
  private publish(id: string) {
    const binding = this.deps.runtimes.get(id)!;
    const session = this.deps.sessions.get(binding.active_session_id);
    this.emit('status', {
      session: session.id,
      status: session.status,
      last_activity_at: session.last_activity_at,
    });
    this.emit('changed', binding.project_id);
  }
  pause(): ReturnType<HostAdmission['pause']> {
    const hold = this.admission.pause();
    this.paused = true;
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      entry.dirty = true;
    }
    let released = false;
    return {
      drain: (timeout) => hold.drain(timeout),
      release: () => {
        if (released) return;
        released = true;
        hold.release();
        this.paused = false;
        for (const [id, entry] of this.entries) this.schedule(id, entry);
      },
    };
  }
  async close() {
    this.closed = true;
    this.admission.close();
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.client.off('changed', entry.changed);
    }
    await this.admission.drain();
    this.entries.clear();
  }
}
