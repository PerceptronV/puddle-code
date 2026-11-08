import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentNativeTurn, AgentTurnSignal, AgentTurnContext } from '@puddle/shared';
import type { AgentControl, LifecycleLaunchContext, LifecycleLaunchResource } from '../adapter.js';
import { schemaPrompt } from '../headless/codec.js';
import type { RuntimeByteAllowance } from '../../runtime/resources/budget.js';
import { RetiredInteractiveTurns } from './retired-turns.js';

/** Match a submitted prompt to native hooks, never terminal activity/quietness. */
export class InteractiveControl implements AgentControl {
  private ref: string | null = null;
  private active: string | null = null;
  private observation: Pick<
    AgentNativeTurn,
    'agentSessionRef' | 'nativeTurnId' | 'automated' | 'automation'
  > | null = null;
  private busy = true;
  private dirty = false;
  private disposed = false;
  private readonly retired: RetiredInteractiveTurns;
  private pending: {
    id: string;
    hash: string;
    accepted: boolean;
    context?: AgentTurnContext;
    finish(error?: Error, reply?: string): void;
  } | null = null;

  constructor(
    private readonly write: (data: string) => void,
    private readonly interrupt: string,
    private awaitingInitialTurn = false,
    private readonly reportNativeTurn?: (event: AgentNativeTurn) => void,
    private readonly reportNativeTurnGap?: (agentSessionRef: string, nativeTurnId: string) => void,
    allowance?: RuntimeByteAllowance,
  ) {
    this.retired = new RetiredInteractiveTurns(allowance);
  }
  get nativeTurnEvents(): boolean {
    return !!this.reportNativeTurn;
  }
  get ready(): boolean {
    return !!this.ref && !this.busy && !this.dirty && !this.pending && !this.disposed;
  }

  lifecycle(ref: string | undefined, ended: boolean): void {
    if (ended && ref !== undefined && ref !== this.ref) return;
    if (ended || ref !== this.ref) {
      this.interruptObservation('Agent changed its native conversation');
      this.pending?.finish(new Error('Agent changed its native conversation'));
      this.active = null;
      this.busy = ended || this.awaitingInitialTurn;
      this.dirty = false;
      this.ref = ended ? null : (ref ?? null);
    }
  }
  input(): void {
    this.interruptObservation('Human input interrupted the native turn');
    this.dirty = true;
    this.pending?.finish(new Error('Human input interrupted the automated turn'));
  }
  signal(event: AgentTurnSignal): 'working' | 'waiting_input' | undefined {
    if (event.agent_session_ref !== this.ref || this.disposed) return;
    if (event.event === 'turn_start') {
      if (event.turn_id === this.active) return;
      this.interruptObservation('Another native turn replaced this turn');
      this.awaitingInitialTurn = false;
      this.busy = true;
      this.dirty = false;
      this.active = event.turn_id;
      if (this.pending) {
        if (event.turn_id !== this.pending.id || event.prompt_hash !== this.pending.hash)
          this.pending.finish(new Error('Another prompt replaced the automated turn'));
        else this.pending.accepted = true;
      }
      const accepted = this.pending?.id === event.turn_id && this.pending.accepted;
      const retired = this.retired.get(event.turn_id);
      const late = retired?.ref === event.agent_session_ref && retired.hash === event.prompt_hash;
      const uncertain = !accepted && !late && (!!retired || this.retired.incomplete);
      if (uncertain) this.reportNativeTurnGap?.(event.agent_session_ref, event.turn_id);
      const context = accepted ? this.pending?.context : late ? retired.context : undefined;
      this.observation = {
        agentSessionRef: event.agent_session_ref,
        nativeTurnId: event.turn_id,
        automated: accepted || late || uncertain,
        ...(context ? { automation: structuredClone(context) } : {}),
      };
      this.reportNativeTurn?.({ ...this.observation, event: 'started' });
      if (late) this.interruptObservation('Native acknowledgement arrived after the ask ended');
      return 'working';
    }
    if (event.turn_id !== this.active) {
      this.reportNativeTurnGap?.(event.agent_session_ref, event.turn_id);
      return;
    }
    if (this.observation) {
      this.reportNativeTurn?.({
        ...this.observation,
        ...(event.event === 'turn_failed' || event.reply === undefined
          ? { event: 'failed', error: event.error || 'Native completion did not include a reply' }
          : { event: 'completed', reply: event.reply }),
      });
      this.observation = null;
    }
    this.busy = false;
    this.active = null;
    if (this.pending?.id !== event.turn_id || !this.pending.accepted) return 'waiting_input';
    if (event.event === 'turn_failed')
      this.pending.finish(new Error(event.error ?? 'Agent turn failed'));
    else if (event.reply === undefined)
      this.pending.finish(new Error('Native completion did not include a reply'));
    else this.pending.finish(undefined, event.reply);
    return 'waiting_input';
  }
  private interruptObservation(error: string): void {
    if (this.observation)
      this.reportNativeTurn?.({ ...this.observation, event: 'interrupted', error });
    this.observation = null;
  }
  ask(
    prompt: string,
    signal: AbortSignal,
    schema?: Record<string, unknown>,
    context?: AgentTurnContext,
  ): Promise<string> {
    if (!this.ready)
      return Promise.reject(new Error('Agent is busy, has a draft, or is not ready'));
    signal.throwIfAborted();
    // Bracketed paste must not carry an escape that could close the frame or
    // execute a command in the native composer.
    // eslint-disable-next-line no-control-regex -- Reject terminal control bytes.
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(prompt))
      return Promise.reject(
        new Error('Interactive prompts cannot contain terminal control characters'),
      );
    const id = randomUUID();
    const ref = this.ref!;
    const text = `${schemaPrompt(prompt, schema)}\n\n[puddle-turn:${id}]`;
    const hash = createHash('sha256').update(text).digest('hex');
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, reply?: string) => {
        if (this.pending?.id !== id) return;
        if (error && !this.pending.accepted && this.reportNativeTurn)
          this.retired.remember({ id, ref, hash, context: this.pending.context });
        this.pending = null;
        clearTimeout(submit);
        clearTimeout(admission);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(reply ?? '');
      };
      const abort = () => {
        this.interruptObservation('Automated turn cancelled');
        this.busy = true;
        this.write(this.interrupt);
        finish(new Error('Automated turn cancelled'));
      };
      const submit = setTimeout(() => {
        if (this.pending?.id === id) this.write('\r');
      }, 50);
      const admission = setTimeout(() => {
        if (this.pending?.id === id && !this.pending.accepted) {
          this.busy = true;
          finish(new Error('Native agent did not acknowledge the prompt; inspect its terminal'));
        }
      }, 15_000);
      this.pending = {
        id,
        hash,
        accepted: false,
        finish,
        ...(context ? { context: structuredClone(context) } : {}),
      };
      this.busy = true;
      signal.addEventListener('abort', abort, { once: true });
      try {
        this.write(`\x1b[200~${text}\x1b[201~`);
      } catch (error) {
        finish(new Error(String(error)));
      }
    });
  }
  dispose(): void {
    this.interruptObservation('Agent terminal closed');
    this.disposed = true;
    this.pending?.finish(new Error('Agent terminal closed'));
    this.retired.close();
  }
}

export function interactiveResource(
  context: LifecycleLaunchContext,
  configDir: string,
  interrupt: string,
): LifecycleLaunchResource {
  if (!context.writeInput) throw new Error('Interactive control needs its owning terminal');
  const control = new InteractiveControl(
    context.writeInput,
    interrupt,
    !!context.opts.prompt,
    context.reportNativeTurn,
    context.reportNativeTurnGap,
    context.bufferAllowance,
  );
  return {
    args: context.args,
    control,
    dispose: async () => {
      control.dispose();
      const hash = createHash('sha256').update(context.signalNonce).digest('hex');
      await rm(
        join(
          context.env?.['PUDDLE_AGENT_TURN_STATE_DIR'] ?? configDir,
          `.puddle-turn-${hash}.json`,
        ),
        { force: true },
      );
    },
  };
}
