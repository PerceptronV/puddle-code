import type { HuddleCompletionSource } from '@puddle/shared';
import type { RuntimeStore } from '../../../db/stores/runtimes.js';
import type { RuntimeConnections } from '../../../runtime/transport/connections.js';
import { RuntimeConnectionLost } from '../../../runtime/transport/client.js';
import type { HuddleOwnerClient } from '../../../runtime/huddle/transport/client.js';
import { HostAdmission } from '../../../host/lifecycle/admission.js';
import {
  HuddleCompletionPending,
  HuddleCompletionReader,
  type CompletionReaderDependencies,
} from './reader.js';
import { requireCompletionOwner, requireCompletionNode } from './authority.js';

interface Entry {
  id: string;
  client: HuddleOwnerClient;
  active: boolean;
  dirty: boolean;
  scanning: boolean;
  retry: number;
  next: number;
  targets: Set<string>;
  changed(): void;
  disconnected(): void;
  timer: ReturnType<typeof setTimeout> | null;
}
class DeliveryFenced extends Error {}
type Dependencies = CompletionReaderDependencies & {
  home: string;
  runtimes: Pick<RuntimeStore, 'live' | 'get' | 'ownerOf' | 'stopRequested'>;
  connections: Pick<RuntimeConnections, 'get' | 'getHuddle' | 'on' | 'off'>;
};

/** Bounded observation retries; every delivery starts from freshly read durable owner cursors. */
export class HuddleCompletionDispatcher {
  private readonly admission = new HostAdmission();
  private readonly reader: HuddleCompletionReader;
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  private closed = false;
  private started = false;
  private scanning = 0;
  private epoch = 0;
  constructor(private readonly deps: Dependencies) {
    this.reader = new HuddleCompletionReader(deps);
  }

  private readonly connected = (id: string, client: HuddleOwnerClient) => this.attach(id, client);
  private readonly targetConnected = (id: string) => {
    for (const entry of this.entries.values()) if (entry.targets.has(id)) entry.changed();
  };
  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.deps.connections.on('huddle-connected', this.connected);
    this.deps.connections.on('connected', this.targetConnected);
    for (const binding of this.deps.runtimes.live()) {
      const client = this.deps.connections.getHuddle(binding.runtime_id);
      if (client) this.attach(binding.runtime_id, client);
    }
  }
  private attach(id: string, client: HuddleOwnerClient) {
    if (
      this.closed ||
      client.state?.capabilities.completionEvents !== 1 ||
      this.entries.get(id)?.client === client
    )
      return;
    const previous = this.entries.get(id);
    if (previous) this.detach(previous);
    const entry: Entry = {
      id,
      client,
      active: true,
      dirty: true,
      scanning: false,
      retry: 0,
      next: 0,
      targets: new Set(),
      timer: null,
      changed: () => {},
      disconnected: () => {},
    };
    entry.changed = () => {
      entry.dirty = true;
      entry.next = 0;
      this.schedule(entry);
    };
    entry.disconnected = () => {
      this.detach(entry);
      if (this.entries.get(id) === entry) this.entries.delete(id);
      this.clock();
    };
    this.entries.set(id, entry);
    client.on('changed', entry.changed);
    client.once('disconnected', entry.disconnected);
    this.clock();
    this.schedule(entry);
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
  private clock() {
    const needed =
      !this.closed &&
      !this.paused &&
      [...this.entries.values()].some((entry) => entry.active || entry.dirty);
    if (!needed && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // One host tick for active subscriptions only. Views and inactive huddles add no polling.
    if (needed && !this.timer)
      this.timer = setInterval(() => {
        for (const entry of this.entries.values())
          if ((entry.active || entry.dirty) && entry.next <= Date.now()) this.schedule(entry);
      }, 1000).unref();
  }
  private schedule(entry: Entry, delay = 25) {
    if (!this.current(entry) || entry.timer || entry.scanning) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.scanning >= 4) return this.schedule(entry, 100);
      void this.scan(entry);
    }, delay).unref();
  }
  private async deliver(entry: Entry, source: HuddleCompletionSource, valid: () => boolean) {
    const guard = () => {
      if (!valid()) throw new DeliveryFenced();
      const binding = this.deps.runtimes.get(entry.id);
      if (!binding) throw new Error('Completion owner binding disappeared');
      return requireCompletionOwner(binding, entry.client, source, this.deps);
    };
    let observed;
    try {
      const scope = guard();
      requireCompletionNode(this.deps.home, this.deps.runtimes.get(entry.id)!, source);
      observed = await this.reader.read(scope, source.target, source.cursor, guard);
      observed.check();
    } catch (error) {
      if (!valid() || error instanceof DeliveryFenced) return false;
      if (error instanceof HuddleCompletionPending || error instanceof RuntimeConnectionLost)
        throw error;
      // The owner checks the exact current source before recording a failure.
      await entry.client.request({
        t: 'completion-unavailable',
        source,
        error: 'Exact completion source, scope or retained definition is no longer available',
      });
      return false;
    }
    if (!valid()) return false;
    const page = observed.page;
    if (
      page.state === 'events' &&
      page.cursor.sequence === source.cursor.sequence &&
      !page.records.length
    )
      return false;
    // Lost acknowledgements escape to scan: no resend before observing the owner's cursor again.
    const response = await entry.client.request({ t: 'completion-events', source, page });
    if (response.t !== 'accepted') throw new Error('Completion delivery was not acknowledged');
    return page.state === 'events' && page.cursor.sequence < page.head;
  }
  private async scan(entry: Entry) {
    if (!this.current(entry)) return;
    entry.scanning = true;
    this.scanning++;
    entry.dirty = false;
    const epoch = this.epoch,
      valid = () => this.current(entry) && epoch === this.epoch;
    let more = false;
    try {
      await this.admission.run(async () => {
        const inspection = await entry.client.request({ t: 'inspect' });
        if (!valid() || inspection.t !== 'state') return;
        if (inspection.state.persistencePending)
          throw new HuddleCompletionPending('Owner persistence is pending');
        if (
          inspection.state.failure ||
          inspection.state.state !== 'running' ||
          inspection.state.control.state !== 'armed'
        ) {
          entry.active = false;
          entry.targets.clear();
          return;
        }
        for (let pass = 0; pass < 4 && valid(); pass++) {
          const response = await entry.client.request({ t: 'completion-sources' });
          if (!valid() || response.t !== 'completion-sources') return;
          entry.active = response.sources.length > 0;
          entry.targets = new Set(
            response.sources.map((source) => source.target.identity.runtime_id),
          );
          more = false;
          for (const source of response.sources) {
            if (!valid()) return;
            more = (await this.deliver(entry, source, valid)) || more;
          }
          if (!more) return;
        }
      });
      entry.retry = 0;
      entry.next = Date.now() + 1000;
    } catch {
      entry.retry = Math.min(entry.retry ? entry.retry * 2 : 1000, 30_000);
      entry.next = Date.now() + entry.retry;
      entry.active = true; // Unknown subscription state must be observed again.
    } finally {
      entry.scanning = false;
      this.scanning--;
      this.clock();
      if (valid() && (entry.dirty || more) && !entry.retry) this.schedule(entry, 250);
    }
  }
  pause(): ReturnType<HostAdmission['pause']> {
    const held = this.admission.pause();
    this.paused = true;
    this.epoch++;
    this.suspend();
    this.clock();
    let released = false;
    return {
      drain: (timeout) => held.drain(timeout),
      release: () => {
        if (released) return;
        released = true;
        held.release();
        this.paused = false;
        for (const entry of this.entries.values()) entry.changed();
        this.clock();
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
    this.epoch++;
    this.admission.close();
    this.suspend();
    this.clock();
    this.deps.connections.off('huddle-connected', this.connected);
    this.deps.connections.off('connected', this.targetConnected);
    for (const entry of this.entries.values()) this.detach(entry);
    await this.admission.drain();
    this.entries.clear();
  }
}
