import { setTimeout as delay } from 'node:timers/promises';
import {
  canonicalHuddleJson,
  huddleJsonSchema,
  huddleAgentOutcomeSchema,
  type HuddleAgentOperation,
  type HuddleAgentOutcome,
} from '@puddle/shared';
import type { RuntimeStore } from '../../../db/stores/runtimes.js';
import type { RuntimeConnections } from '../../../runtime/transport/connections.js';
import type { RuntimeReconciler } from '../../../runtime/controller/reconcile.js';
import type { HuddleOwnerClient } from '../../../runtime/huddle/transport/client.js';
import { HostAdmission } from '../../../host/lifecycle/admission.js';
import type { HuddleAgentTurns } from '../turns/service.js';
import { validateHuddleOperation } from './authority.js';

interface Task {
  operation: HuddleAgentOperation;
  abort: AbortController;
}
interface Entry {
  id: string;
  client: HuddleOwnerClient;
  changed: () => void;
  cursor: number;
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
        if (!entry.cursor) entry.dirty = false;
        // Yield after four bounded pages; never retain a whole owner's history.
        for (let pass = 0; pass < 4 && this.current(entry); pass++) {
          const response = await entry.client.request({ t: 'operation-page', after: entry.cursor });
          if (!this.current(entry) || response.t !== 'operation-page') return;
          if (
            response.page.next < entry.cursor ||
            response.page.records.some((row) => row.ordinal <= entry.cursor)
          )
            throw new Error('Owner operation page moved behind its requested cursor');
          for (const { operation } of response.page.records) {
            const existing = entry.tasks.get(operation.scope.operationId);
            if (existing) {
              existing.operation = operation;
              if (!operation.active) existing.abort.abort(new Error('Huddle invocation ended'));
              continue;
            }
            if (
              operation.state === 'cancelled' ||
              (operation.result && 'rejected' in operation.result)
            )
              continue;
            if (this.tasks >= 64) {
              again = true;
              return;
            }
            const binding = this.deps.runtimes.get(entry.id);
            if (!binding) return;
            validateHuddleOperation(this.deps.home, binding, entry.client, operation);
            const task = { operation, abort: new AbortController() };
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
    const { scope, request } = task.operation;
    const turns = this.deps.turns;
    const authority = (mode: 'dispatch' | 'observe') => {
      const connected = this.current(entry);
      const stopping = this.deps.runtimes.stopRequested(entry.id);
      return (
        !this.paused &&
        !this.closed &&
        (connected || (mode === 'observe' && stopping)) &&
        (mode === 'observe' ||
          (task.operation.active &&
            Date.now() < task.operation.deadline &&
            !task.abort.signal.aborted))
      );
    };
    const timer = setTimeout(
      () => task.abort.abort(new Error('Huddle operation deadline reached')),
      Math.max(1, Math.min(2_147_483_647, task.operation.deadline - Date.now())),
    );
    timer.unref();
    let invoked = false;
    let outcomeObserved = false;
    let settlementAttempted = false;
    const settle = async (result: HuddleAgentOutcome) => {
      if (!huddleAgentOutcomeSchema.safeParse(result).success)
        throw new Error('Agent reply exceeds huddle outcome limits');
      settlementAttempted = true;
      const saved = await entry.client.request({ t: 'operation-settle', scope, result });
      if (!this.current(entry)) return;
      if (
        saved.t !== 'operation-settled' ||
        saved.operationId !== scope.operationId ||
        canonicalHuddleJson(saved.result) !== canonicalHuddleJson(result)
      )
        throw new Error('Owner did not confirm its exact retained outcome');
      turns.acknowledge(scope, request, result.receipt, authority);
    };
    try {
      if (task.operation.result && 'turn' in task.operation.result) {
        turns.acknowledge(scope, request, task.operation.result.receipt, authority);
        return;
      }
      if (task.operation.state === 'prepared') {
        if (!authority('dispatch')) return;
        const claimed = await entry.client.request({
          t: 'operation-claim',
          operationId: scope.operationId,
        });
        if (!this.current(entry) || claimed.t !== 'operation-claim') return;
        if (
          canonicalHuddleJson(claimed.operation.scope) !== canonicalHuddleJson(scope) ||
          canonicalHuddleJson(huddleJsonSchema.parse(claimed.operation.request)) !==
            canonicalHuddleJson(huddleJsonSchema.parse(request))
        )
          throw new Error('Claim changed the retained operation');
        task.operation = claimed.operation;
        if (claimed.dispatch) {
          invoked = true;
          await turns.ask(scope, request, task.abort.signal, authority, () => true);
        }
      }
      for (;;) {
        if (!this.current(entry)) return;
        const observed = turns.observe(scope, request, authority);
        if (observed.result && observed.receipt) {
          outcomeObserved = true;
          await settle({ turn: observed.result, receipt: observed.receipt });
          return;
        }
        task.abort.signal.throwIfAborted();
        if (!task.operation.active) {
          task.abort.abort(new Error('Huddle invocation ended'));
          task.abort.signal.throwIfAborted();
        }
        await delay(250, undefined, { signal: task.abort.signal });
      }
    } catch (error) {
      if (
        task.abort.signal.aborted &&
        !this.closed &&
        !this.paused &&
        (this.current(entry) || this.deps.runtimes.stopRequested(entry.id))
      ) {
        try {
          await turns.cancel(scope, request, authority);
        } catch {
          /* Exact intent prevents a second cancellation send. */
        }
      }
      if (!this.current(entry)) return;
      if (settlementAttempted) {
        entry.changed(); // Re-read the owner ledger before another settlement attempt.
        return;
      }
      if (!invoked && !outcomeObserved) return;
      // A terminal agent failure still has a result requiring durable settlement.
      try {
        const observed = turns.observe(scope, request, authority);
        if (observed.result && observed.receipt) {
          await settle({ turn: observed.result, receipt: observed.receipt });
          return;
        }
      } catch {
        /* Keep retained host results unacknowledged when settlement is unavailable. */
      }
      if (settlementAttempted) {
        entry.changed();
        return;
      }
      try {
        await entry.client.request({
          t: 'operation-unavailable',
          scope,
          unsent: turns.unused(scope, request, authority),
          error:
            (error instanceof Error ? error.message : String(error)).slice(0, 4096) ||
            'Agent operation failed',
        });
      } catch {
        /* Lost replies remain observation-only. */
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
