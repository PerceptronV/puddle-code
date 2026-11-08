import type { HuddleDefinition, HuddleRuntimeCapabilities } from '@puddle/shared';
import type { RuntimeByteAllowance } from '../../resources/budget.js';
import type { HuddleLedger } from '../state/ledger.js';
import type { HuddleRevisionStore } from '../state/revisions.js';
import { intervalDefinitions, requireHuddleFeatures } from './definitions.js';

/** One deadline timer per owner, independent of controller/renderer connections. */
export class HuddleTimerController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private release: (() => void) | undefined;
  private generation: number | null = null;
  private limits: HuddleDefinition['execution'] | null = null;
  constructor(
    private readonly ledger: HuddleLedger,
    private readonly revisions: HuddleRevisionStore,
    private readonly capabilities: HuddleRuntimeCapabilities,
    private readonly admitted: () => void,
    private readonly failed: (error: unknown) => void,
    private readonly beforeAdmission: () => void,
    private readonly allowance?: RuntimeByteAllowance,
  ) {}

  refresh() {
    this.stop();
    const control = this.ledger.activations.current();
    if (control.state !== 'armed' || !control.activationId) return;
    const activation = this.ledger.activations.get(control.activationId);
    const snapshot = this.revisions.read(activation.revision);
    requireHuddleFeatures(snapshot, this.capabilities);
    const definitions = intervalDefinitions(snapshot, activation);
    if (!definitions.length) return;
    const release = this.allowance?.reserve(64 * 1024);
    if (this.allowance && !release)
      throw new Error('No host memory capacity for interval triggers');
    this.release = release ?? undefined;
    try {
      this.ledger.intervals.synchronise(activation, definitions, Date.now());
      this.generation = control.generation;
      this.limits = snapshot.definition.execution;
      this.schedule();
    } catch (error) {
      this.stop();
      throw error;
    }
  }
  stop() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.release?.();
    this.release = undefined;
    this.generation = null;
    this.limits = null;
  }
  private schedule() {
    const state = this.ledger.intervals.current();
    if (!state || state.generation !== this.generation || !state.schedules.length) return;
    const deadline = Math.min(
      ...state.schedules.map((item) => item.anchor + (item.last + 1) * item.intervalMs),
    );
    this.timer = setTimeout(
      () => this.tick(),
      Math.max(1, Math.min(86400000, deadline - Date.now())),
    );
  }
  private tick() {
    this.timer = undefined;
    let node = '';
    let count = 0;
    let notified = false;
    try {
      const control = this.ledger.activations.current();
      if (!this.limits || control.generation !== this.generation || control.state !== 'armed') {
        this.stop();
        return;
      }
      this.beforeAdmission();
      // One occurrence per source per pass; bounded catch-up cannot monopolise the event loop.
      for (let pass = 0; pass < 64 && count < 64; pass++) {
        let progressed = false;
        for (const schedule of this.ledger.intervals.current()!.schedules) {
          node = schedule.node;
          if (this.ledger.intervals.admit(node, this.limits, Date.now())) {
            count++;
            progressed = true;
          }
          if (count >= 64) break;
        }
        if (!progressed) break;
      }
      if (count) {
        notified = true;
        this.admitted();
      }
      this.schedule();
    } catch (error) {
      // Preserve progress from an earlier committed admission in this bounded batch.
      if (count && !notified) {
        try {
          this.admitted();
        } catch {
          /* Report the original admission failure. */
        }
      }
      this.stop();
      this.failed(
        new Error(
          `${node ? `Interval ${node}` : 'Interval triggers'}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
}
