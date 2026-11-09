import {
  huddleTriggerReportSchema,
  type HuddleCommandTarget,
  type HuddleTriggerReport,
} from '@puddle/shared';
import type { HuddleLedger } from '../state/ledger.js';
import type { HuddleRevisionStore } from '../state/revisions.js';
import { nextScheduleDeadline } from '../triggers/calendar/occurrences.js';

/** Observes the installed subscriptions and retained admission state; never refreshes a source. */
export function inspectHuddleTriggers(
  ledger: HuddleLedger,
  store: HuddleRevisionStore,
  target: HuddleCommandTarget,
  ready: boolean,
  failure: string | null,
): HuddleTriggerReport {
  const control = ledger.activations.current();
  if (control.generation !== target.generation || control.activationId !== target.activationId)
    throw new Error('Trigger inspection target is stale');
  const activity = ledger.triggerActivity(control.activationId);
  const snapshot = control.activationId
    ? store.read(ledger.activations.get(control.activationId).revision)
    : null;
  const intervals = ledger.intervals.current();
  const schedules = ledger.schedules.current();
  const custom = ledger.customTriggers.list();
  const armed = control.state === 'armed';
  const sources: HuddleTriggerReport['sources'] = [];
  for (const node of snapshot?.definition.nodes ?? []) {
    const component = snapshot!.components[node.id]!;
    if (component.category !== 'trigger') continue;
    const source: HuddleTriggerReport['sources'][number] = {
      node: node.id,
      component: component.id,
      admitted: 0,
      queued: 0,
      running: 0,
      last_event_at: null,
      coalesced: 0,
      skipped: 0,
      ...activity.sources.find((item) => item.node === node.id),
      health: failure ? 'blocked' : !armed ? 'inactive' : ready ? 'ready' : 'starting',
      ...(failure ? { message: failure } : {}),
      next_at: null,
    };
    // Retained progress remains useful when inactive; only current subscriptions get deadlines.
    const interval =
      intervals?.activationId === control.activationId
        ? intervals.schedules.find((item) => item.node === node.id)
        : undefined;
    const schedule =
      schedules?.activationId === control.activationId
        ? schedules.schedules.find((item) => item.node === node.id)
        : undefined;
    if (interval) {
      source.missed = interval.missed;
      if (source.health === 'ready' && intervals!.generation === control.generation)
        source.next_at = new Date(
          interval.anchor + (interval.last + 1) * interval.intervalMs,
        ).toISOString();
    }
    if (schedule) {
      source.missed = schedule.kind === 'date' ? schedule.past : schedule.missed;
      if (schedule.kind === 'date') {
        source.disposition = schedule.disposition;
        if (schedule.disposition !== 'pending' && source.health === 'ready')
          source.health = 'complete';
      }
      if (source.health === 'ready' && schedules!.generation === control.generation) {
        const deadline = nextScheduleDeadline(schedule);
        source.next_at = deadline === null ? null : new Date(deadline).toISOString();
      }
    }
    if (node.source.kind === 'local' && !component.hostTrigger && source.health === 'ready') {
      const retained = custom.find(
        (item) =>
          item.node === node.id &&
          item.activationId === control.activationId &&
          item.generation === control.generation,
      );
      source.health = retained?.health.state ?? 'starting';
      if (retained && 'message' in retained.health) source.message = retained.health.message;
    }
    sources.push(source);
  }
  return huddleTriggerReportSchema.parse({
    target,
    observed_at: new Date().toISOString(),
    lifecycle: control.state,
    backlog: activity.backlog,
    queue_limit: snapshot?.definition.execution.maxQueuedEvents ?? null,
    sources,
  });
}
