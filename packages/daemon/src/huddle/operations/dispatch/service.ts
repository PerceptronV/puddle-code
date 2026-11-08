import type { HuddleAgentLifecycle } from '../lifecycle/service.js';
import { executeHuddleLifecycle } from './lifecycle.js';
import type {
  HuddleAgentOperation,
  HuddleSpawnOperation,
  HuddleLifecycleOperation,
} from '@puddle/shared';
import type { RuntimeStore } from '../../../db/stores/runtimes.js';
import type { RuntimeConnections } from '../../../runtime/transport/connections.js';
import type { RuntimeReconciler } from '../../../runtime/controller/reconcile.js';
import type { HuddleOwnerClient } from '../../../runtime/huddle/transport/client.js';
import { HostAdmission } from '../../../host/lifecycle/admission.js';
import type { HuddleAgentTurns } from '../turns/service.js';
import {
  validateHuddleOperation,
  validateHuddleSpawn,
  validateHuddleLifecycle,
} from './authority.js';
import type { HuddleAgentSpawns } from '../spawns/service.js';
import type { HuddleDispatchTask } from './context.js';
import { executeHuddleAsk } from './turns.js';
import { executeHuddleSpawn } from './spawns.js';
import { cleanupHuddleSpawn } from './cleanup.js';

type Task =
  | ({ kind: 'ask' } & HuddleDispatchTask<HuddleAgentOperation>)
  | ({ kind: 'spawn' } & HuddleDispatchTask<HuddleSpawnOperation>)
  | ({ kind: 'lifecycle' } & HuddleDispatchTask<HuddleLifecycleOperation>);
interface Entry {
  id: string;
  client: HuddleOwnerClient;
  changed: () => void;
  cursor: number;
  lane: Task['kind'];
  dirty: boolean;
  scanning: boolean;
  timer: NodeJS.Timeout | null;
  tasks: Map<string, Task>;
}

/** Daemon-owned dispatch only; the independent owner retains intent, scripts and results. */
export class HuddleAgentDispatcher {
  private readonly admission = new HostAdmission();
  private readonly entries = new Map<string, Entry>();
  private paused = false;
  private closed = false;
  private scans = 0;
  private tasks = 0;
  constructor(
    private readonly deps: {
      home: string;
      runtimes: RuntimeStore;
      connections: RuntimeConnections;
      reconciler: RuntimeReconciler;
      turns: HuddleAgentTurns;
      spawns?: HuddleAgentSpawns;
      lifecycle?: HuddleAgentLifecycle;
    },
  ) {}

  private readonly connected = (id: string, client: HuddleOwnerClient) => this.attach(id, client);
  private readonly observed = (project: string) => {
    for (const entry of this.entries.values())
      if (entry.client.state?.identity.project_id === project) entry.changed();
  };
  start() {
    this.deps.connections.on('huddle-connected', this.connected);
    this.deps.reconciler.on('changed', this.observed);
    for (const binding of this.deps.runtimes.live()) {
      const client = this.deps.connections.getHuddle(binding.runtime_id);
      if (client) this.attach(binding.runtime_id, client);
    }
  }
  private attach(id: string, client: HuddleOwnerClient) {
    if (this.closed || client.state?.capabilities.operations !== 2) return;
    if (this.entries.get(id)?.client === client) return;
    const entry: Entry = {
      id,
      client,
      cursor: 0,
      lane: 'ask',
      dirty: true,
      scanning: false,
      timer: null,
      tasks: new Map(),
      changed: () => {},
    };
    entry.changed = () => {
      entry.dirty = true;
      this.schedule(entry);
    };
    this.entries.set(id, entry);
    client.on('changed', entry.changed);
    client.once('disconnected', () => {
      client.off('changed', entry.changed);
      if (entry.timer) clearTimeout(entry.timer);
      for (const task of entry.tasks.values())
        task.abort.abort(new Error('Huddle owner disconnected'));
      if (this.entries.get(id) === entry) this.entries.delete(id);
    });
    this.schedule(entry);
  }
  private current(entry: Entry) {
    return (
      !this.closed && !this.paused && this.deps.connections.getHuddle(entry.id) === entry.client
    );
  }
  private schedule(entry: Entry, wait = 25) {
    if (!this.current(entry) || entry.timer || entry.scanning) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.scans >= 4) return this.schedule(entry, 100);
      void this.scan(entry);
    }, wait);
    entry.timer.unref();
  }
  private async scan(entry: Entry) {
    if (!this.current(entry)) return;
    entry.scanning = true;
    this.scans++;
    let again = false;
    try {
      await this.admission.run(async () => {
        if (!entry.cursor && entry.lane === 'ask') entry.dirty = false;
        // All lanes share four page passes and the host-wide task bound.
        for (let pass = 0; pass < 4 && this.current(entry); pass++) {
          const response = await entry.client.request({
            t:
              entry.lane === 'ask'
                ? 'operation-page'
                : entry.lane === 'spawn'
                  ? 'spawn-page'
                  : 'lifecycle-page',
            after: entry.cursor,
          });
          if (!this.current(entry)) return;
          if (
            (entry.lane === 'ask' && response.t !== 'operation-page') ||
            (entry.lane === 'spawn' && response.t !== 'spawn-page') ||
            (entry.lane === 'lifecycle' && response.t !== 'lifecycle-page')
          )
            return;
          if (
            response.t !== 'operation-page' &&
            response.t !== 'spawn-page' &&
            response.t !== 'lifecycle-page'
          )
            return;
          if (
            response.page.next < entry.cursor ||
            response.page.records.some((row) => row.ordinal <= entry.cursor)
          )
            throw new Error('Owner operation page moved behind its requested cursor');
          const candidates: Task[] =
            response.t === 'operation-page'
              ? response.page.records.map(({ operation }) => ({
                  kind: 'ask',
                  operation,
                  abort: new AbortController(),
                }))
              : response.t === 'spawn-page'
                ? response.page.records.map(({ operation }) => ({
                    kind: 'spawn',
                    operation,
                    abort: new AbortController(),
                  }))
                : response.page.records.map(({ operation }) => ({
                    kind: 'lifecycle',
                    operation,
                    abort: new AbortController(),
                  }));
          for (const task of candidates) {
            const operation = task.operation;
            const existing = entry.tasks.get(operation.scope.operationId);
            if (existing) {
              if (existing.kind === 'ask' && task.kind === 'ask')
                existing.operation = task.operation;
              else if (existing.kind === 'spawn' && task.kind === 'spawn')
                existing.operation = task.operation;
              else if (existing.kind === 'lifecycle' && task.kind === 'lifecycle')
                existing.operation = task.operation;
              else throw new Error('Owner operation changed kind');
              if (!operation.active) existing.abort.abort(new Error('Huddle invocation ended'));
              continue;
            }
            if (
              (task.kind !== 'spawn' || task.operation.cleanup.state !== 'pending') &&
              (operation.state === 'cancelled' ||
                (task.kind === 'lifecycle' && ['completed', 'failed'].includes(operation.state)) ||
                (operation.result && 'rejected' in operation.result) ||
                (task.kind === 'spawn' &&
                  (operation.state === 'completed' ||
                    ['confirmed', 'released'].includes(task.operation.cleanup.state))))
            )
              continue;
            if (this.tasks >= 64) {
              again = true;
              return;
            }
            const binding = this.deps.runtimes.get(entry.id);
            if (!binding) return;
            if (task.kind === 'ask')
              validateHuddleOperation(this.deps.home, binding, entry.client, task.operation);
            else if (task.kind === 'spawn')
              validateHuddleSpawn(this.deps.home, binding, entry.client, task.operation);
            else validateHuddleLifecycle(this.deps.home, binding, entry.client, task.operation);
            entry.tasks.set(operation.scope.operationId, task);
            this.tasks++;
            void this.admission
              .run(() => this.execute(entry, task))
              .catch(() => {})
              .finally(() => {
                entry.tasks.delete(operation.scope.operationId);
                this.tasks--;
              });
          }
          if (response.page.next === entry.cursor) {
            entry.cursor = 0;
            if (
              entry.lane === 'ask' &&
              this.deps.spawns &&
              entry.client.state?.capabilities.spawns === 1
            ) {
              entry.lane = 'spawn';
              continue;
            }
            if (
              entry.lane !== 'lifecycle' &&
              this.deps.lifecycle &&
              entry.client.state?.capabilities.lifecycle === 1
            ) {
              entry.lane = 'lifecycle';
              continue;
            }
            entry.lane = 'ask';
            again = entry.dirty;
            return;
          }
          entry.cursor = response.page.next;
        }
        again = true;
      });
    } catch {
      again = true;
    } finally {
      entry.scanning = false;
      this.scans--;
      if (again || entry.dirty) this.schedule(entry, 250);
    }
  }
  private async execute(entry: Entry, task: Task) {
    const authority = (mode: 'dispatch' | 'observe') => {
      const connected = this.current(entry);
      const stopping = this.deps.runtimes.stopRequested(entry.id);
      return (
        !this.paused &&
        !this.closed &&
        (connected || (mode === 'observe' && stopping)) &&
        (mode === 'observe' ||
          (task.operation.scope.owner.runtime_id === entry.id &&
            task.operation.active &&
            Date.now() < task.operation.deadline &&
            !task.abort.signal.aborted))
      );
    };
    const timer = setTimeout(
      () => task.abort.abort(new Error('Huddle operation deadline reached')),
      Math.max(1, Math.min(2_147_483_647, task.operation.deadline - Date.now())),
    );
    timer.unref();
    const context = {
      client: entry.client,
      current: () => this.current(entry),
      authority,
      changed: entry.changed,
      canCancel: () =>
        !this.closed &&
        !this.paused &&
        (this.current(entry) || this.deps.runtimes.stopRequested(entry.id)),
    };
    try {
      if (task.kind === 'ask') await executeHuddleAsk({ ...context, task }, this.deps.turns);
      else if (task.kind === 'lifecycle' && this.deps.lifecycle)
        await executeHuddleLifecycle({ ...context, task }, this.deps.lifecycle);
      else if (task.kind === 'spawn' && this.deps.spawns) {
        const cleanupPending = () => task.operation.cleanup.state === 'pending';
        if (cleanupPending()) await cleanupHuddleSpawn({ ...context, task }, this.deps.spawns);
        else {
          await executeHuddleSpawn({ ...context, task }, this.deps.spawns);
          if (this.current(entry) && cleanupPending()) entry.changed();
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
  pause(): ReturnType<HostAdmission['pause']> {
    const hold = this.admission.pause();
    this.paused = true;
    this.suspend();
    let released = false;
    return {
      drain: (timeout) => hold.drain(timeout),
      release: () => {
        if (released) return;
        released = true;
        hold.release();
        this.paused = false;
        for (const entry of this.entries.values()) {
          entry.cursor = 0;
          entry.lane = 'ask';
          entry.changed();
        }
      },
    };
  }
  private suspend() {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      for (const task of entry.tasks.values())
        task.abort.abort(new Error('Huddle dispatcher suspended'));
    }
  }
  async close() {
    this.closed = true;
    this.admission.close();
    this.suspend();
    this.deps.connections.off('huddle-connected', this.connected);
    this.deps.reconciler.off('changed', this.observed);
    for (const entry of this.entries.values()) entry.client.off('changed', entry.changed);
    await this.admission.drain();
    this.entries.clear();
  }
}
