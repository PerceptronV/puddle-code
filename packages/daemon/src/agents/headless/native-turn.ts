import type { AgentNativeTurn, AgentTurnContext } from '@puddle/shared';
import type { LifecycleLaunchContext } from '../adapter.js';
import { RuntimeBufferBudget } from '../../runtime/resources/budget.js';

/** One exact CLI invocation; its command key is not a provider-issued turn id. */
export class HeadlessTurnObservation {
  private ref: string | undefined;
  private started = false;
  private ended = false;
  private gapReported = false;
  private release: (() => void) | null;
  private readonly automation: AgentTurnContext | undefined;

  constructor(
    private readonly id: string,
    context: AgentTurnContext | undefined,
    private readonly report: LifecycleLaunchContext['reportNativeTurn'],
    private readonly gap: LifecycleLaunchContext['reportNativeTurnGap'],
    allowance: LifecycleLaunchContext['bufferAllowance'],
  ) {
    this.release = report
      ? new RuntimeBufferBudget({ bytes: 4096, count: 1 }, allowance).reserve(4096)
      : null;
    this.automation = this.release && context ? structuredClone(context) : undefined;
  }

  identify(ref: string): void {
    this.ref = ref;
    if (this.ended && !this.started) this.lost();
  }

  /** Called only after exact conversation binding has settled. */
  start(): void {
    if (this.started || this.ended || !this.ref || !this.report) return;
    if (!this.release) {
      this.lost();
      return;
    }
    this.started = true;
    this.emit({ event: 'started' });
  }

  finish(reply: string, error?: Error, interrupted = false): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.started) this.lost();
    else
      this.emit(
        error
          ? {
              event: interrupted ? 'interrupted' : 'failed',
              error: error.message.slice(0, 4096) || 'Headless turn failed',
            }
          : { event: 'completed', reply },
      );
  }

  private emit(outcome: Pick<AgentNativeTurn, 'event' | 'reply' | 'error'>): void {
    try {
      this.report?.({
        ...outcome,
        agentSessionRef: this.ref!,
        nativeTurnId: `command:${this.id}`,
        automated: true,
        ...(this.automation ? { automation: this.automation } : {}),
      });
    } catch {
      this.lost();
    }
  }

  private lost(): void {
    if (this.report && this.ref && !this.gapReported) {
      this.gapReported = true;
      try {
        this.gap?.(this.ref, `command:${this.id}`);
      } catch {
        // Optional source observation cannot own the native command's lifetime.
      }
    }
  }

  close(): void {
    this.release?.();
    this.release = null;
  }
}
