import type { HuddleSessionSource } from '@puddle/shared';
import type { RuntimeStore } from '../../../db/stores/runtimes.js';
import type { SessionStore } from '../../../db/stores/sessions.js';
import type { ProjectStore } from '../../../db/stores/projects.js';
import type { RuntimeConnections } from '../../../runtime/transport/connections.js';
import type { HuddleOwnerClient } from '../../../runtime/huddle/transport/client.js';
import { HostAdmission } from '../../../host/lifecycle/admission.js';
import { HuddleSessionFeed } from './feed.js';
import { validateSessionSubscription } from './authority.js';

interface Entry {
  id: string;
  client: HuddleOwnerClient;
  changed: () => void;
  disconnected: () => void;
  dirty: boolean;
  scanning: boolean;
  checkpoint: string;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Re-read durable owner cursors before delivery, including after any uncertain reply. */
export class HuddleSessionDispatcher {
  private readonly admission = new HostAdmission();
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  private closed = false;
  private started = false;
  private scanning = 0;
  constructor(
    private readonly deps: {
      home: string;
      feed: HuddleSessionFeed;
      runtimes: RuntimeStore;
      connections: RuntimeConnections;
      sessions: Pick<SessionStore, 'get'>;
      projects: Pick<ProjectStore, 'get'>;
    },
  ) {}
  private readonly connected = (id: string, client: HuddleOwnerClient) => this.attach(id, client);
  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.deps.connections.on('huddle-connected', this.connected);
    for (const binding of this.deps.runtimes.live()) {
      const client = this.deps.connections.getHuddle(binding.runtime_id);
      if (client) this.attach(binding.runtime_id, client);
    }
  }
  private attach(id: string, client: HuddleOwnerClient) {
    if (
      this.closed ||
      client.state?.capabilities.sessionEvents !== 1 ||
      this.entries.get(id)?.client === client
    )
      return;
    const previous = this.entries.get(id);
    if (previous) this.detach(previous);
    const entry: Entry = {
      id,
      client,
      dirty: true,
      scanning: false,
      checkpoint: '',
      timer: null,
      changed: () => {},
      disconnected: () => {},
    };
    entry.changed = () => {
      entry.dirty = true;
      this.schedule(entry);
    };
    this.entries.set(id, entry);
    client.on('changed', entry.changed);
    entry.disconnected = () => {
      this.detach(entry);
      if (this.entries.get(id) === entry) this.entries.delete(id);
      if (!this.entries.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
    client.once('disconnected', entry.disconnected);
    // One cheap host checkpoint read per second, no per-window polling.
    if (!this.timer) this.timer = setInterval(() => this.tick(), 1000).unref();
    this.schedule(entry);
  }
  private tick() {
    if (this.closed || this.paused) return;
    let checkpoint = '';
    try {
      checkpoint = JSON.stringify(this.deps.feed.checkpoint());
    } catch {
      /* A scan reports source failure to each exact active subscription. */
    }
    for (const entry of this.entries.values())
      if (entry.dirty || checkpoint !== entry.checkpoint) this.schedule(entry);
  }
  private current(entry: Entry) {
    return (
      !this.closed &&
      !this.paused &&
      this.entries.get(entry.id) === entry &&
      this.deps.connections.getHuddle(entry.id) === entry.client &&
      !this.deps.runtimes.stopRequested(entry.id)
    );
  }
  private schedule(entry: Entry, delay = 25) {
    if (!this.current(entry) || entry.timer || entry.scanning) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.scanning >= 4) return this.schedule(entry, 100);
      void this.scan(entry);
    }, delay).unref();
  }
  private async deliver(entry: Entry, source: HuddleSessionSource) {
    const binding = this.deps.runtimes.get(entry.id);
    if (!binding || !this.current(entry)) return false;
    let page;
    try {
      validateSessionSubscription(
        this.deps.home,
        binding,
        entry.client,
        source,
        this.deps.sessions,
        this.deps.projects,
      );
      page = this.deps.feed.read(source.scope, source.cursor);
    } catch (error) {
      if (this.current(entry))
        await entry.client.request({
          t: 'session-unavailable',
          source,
          error:
            (error instanceof Error ? error.message : String(error)).slice(0, 4096) ||
            'Session observation unavailable',
        });
      return false;
    }
    if (!this.current(entry)) return false;
    if (
      page.state === 'events' &&
      page.cursor.sequence === source.cursor.sequence &&
      !page.records.length
    )
      return false;
    const response = await entry.client.request({ t: 'session-events', source, page });
    if (response.t !== 'accepted') throw new Error('Session event delivery was not acknowledged');
    return page.state === 'events' && page.cursor.sequence < page.head;
  }
  private async scan(entry: Entry) {
    if (!this.current(entry)) return;
    entry.scanning = true;
    this.scanning++;
    entry.dirty = false;
    let again = false;
    try {
      await this.admission.run(async () => {
        let checkpoint = '';
        try {
          checkpoint = JSON.stringify(this.deps.feed.checkpoint());
        } catch {
          /* Deliver a source failure after inspecting the owner. */
        }
        for (let pass = 0; pass < 4 && this.current(entry); pass++) {
          const response = await entry.client.request({ t: 'session-sources' });
          if (!this.current(entry) || response.t !== 'session-sources') return;
          let more = false;
          for (const source of response.sources) more = (await this.deliver(entry, source)) || more;
          if (!more) {
            entry.checkpoint = checkpoint;
            return;
          }
        }
        again = true;
      });
    } catch {
      again = true;
    } finally {
      // Re-observe cursor/activation before any further delivery.
      entry.scanning = false;
      this.scanning--;
      if (again || entry.dirty) this.schedule(entry, 250);
    }
  }
  pause(): ReturnType<HostAdmission['pause']> {
    const held = this.admission.pause();
    this.paused = true;
    this.suspend();
    let released = false;
    return {
      drain: (timeout) => held.drain(timeout),
      release: () => {
        if (released) return;
        released = true;
        held.release();
        this.paused = false;
        for (const entry of this.entries.values()) entry.changed();
      },
    };
  }
  private suspend() {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
    }
  }
  private detach(entry: Entry) {
    entry.client.off('changed', entry.changed);
    entry.client.off('disconnected', entry.disconnected);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
  }
  async close() {
    this.closed = true;
    this.admission.close();
    this.suspend();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.deps.connections.off('huddle-connected', this.connected);
    for (const entry of this.entries.values()) this.detach(entry);
    await this.admission.drain();
    this.entries.clear();
  }
}
