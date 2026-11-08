import { randomUUID } from 'node:crypto';
import type { AgentTurnContext } from '@puddle/shared';
import type { AgentControl, LifecycleLaunchContext } from '../adapter.js';
import { CodexTurnObservations } from './turns/observations.js';
import { RuntimeBufferBudget, type RuntimeByteAllowance } from '../../runtime/resources/budget.js';
import { runtimeJsonBytes, runtimeJsonRetainedBytes } from '../../runtime/transport/encoding.js';

type RecordValue = Record<string, unknown>;
const validTurnId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096;
const diagnostic = (value: unknown, fallback: string) =>
  // Copy the bounded prefix: a sliced diagnostic must not pin its native source.
  typeof value === 'string' ? Buffer.from(value.slice(0, 4096)).toString('utf8') : fallback;
const record = (v: unknown): RecordValue =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as RecordValue) : {};

/** Exact turn control on the TUI's existing connection; Codex 0.159.0 schema. */
export class CodexControl implements AgentControl {
  private send: ((message: RecordValue) => void) | null = null;
  private thread: string | null = null;
  private busy = false;
  private readonly abandoned = new Map<string, { thread: string; release(): void }>();
  private readonly turns: RuntimeBufferBudget;
  private readonly requests: RuntimeBufferBudget;
  private readonly earlyEvents: RuntimeBufferBudget;
  private readonly observations: CodexTurnObservations | null;
  constructor(
    allowance?: RuntimeByteAllowance,
    observers?: Pick<LifecycleLaunchContext, 'reportNativeTurn' | 'reportNativeTurnGap'>,
  ) {
    this.observations = observers?.reportNativeTurn
      ? new CodexTurnObservations(
          allowance,
          observers.reportNativeTurn,
          observers.reportNativeTurnGap,
        )
      : null;
    this.earlyEvents = new RuntimeBufferBudget({ bytes: 32 * 1024 * 1024, count: 256 }, allowance);
    this.turns = new RuntimeBufferBudget({ bytes: 8 * 1024 * 1024, count: 1 }, allowance);
    this.requests = new RuntimeBufferBudget({ bytes: 1024 * 1024, count: 256 }, allowance);
  }
  private pending: {
    id: string;
    thread: string;
    turn: string | null;
    reply: string;
    early: Array<{ value: RecordValue; release(): void }>;
    earlyBytes: number;
    finish(error?: Error, reply?: string): void;
  } | null = null;

  get ready(): boolean {
    return this.send !== null && this.thread !== null && !this.busy && !this.pending;
  }
  get nativeTurnEvents(): boolean {
    return this.observations !== null;
  }

  connect(send: (message: RecordValue) => void): void {
    this.disconnect();
    this.send = send;
  }

  bind(thread: string): void {
    if (this.thread !== thread) {
      this.observations?.bind(thread);
      this.pending?.finish(new Error('The agent changed its native conversation'));
      this.thread = thread;
      this.busy = false;
    }
  }

  disconnect(): void {
    this.pending?.finish(new Error('The agent control connection closed'));
    this.observations?.disconnect();
    this.send = null;
    this.thread = null;
    this.busy = false;
    for (const entry of this.abandoned.values()) entry.release();
    this.abandoned.clear();
  }

  /** Human turns and native switches cannot be attributed to a automated ask. */
  client(message: RecordValue): void {
    const method = message['method'];
    if (
      method === 'turn/start' ||
      method === 'turn/steer' ||
      method === 'turn/interrupt' ||
      method === 'thread/start' ||
      method === 'thread/resume' ||
      method === 'thread/fork'
    ) {
      if (
        record(message['params'])['threadId'] === this.thread ||
        record(message['params'])['threadId'] === undefined
      )
        this.observations?.interrupt('Human or native input interrupted the turn');
      this.pending?.finish(new Error('Human or native input interrupted the automated turn'));
      if (method === 'turn/start' && record(message['params'])['threadId'] === this.thread)
        this.busy = true;
    }
  }

  ask(
    prompt: string,
    signal: AbortSignal,
    outputSchema?: RecordValue,
    context?: AgentTurnContext,
  ): Promise<string> {
    if (!this.ready || !this.thread || !this.send)
      return Promise.reject(new Error('Agent is busy or not ready'));
    signal.throwIfAborted();
    const id = `puddlang:${randomUUID()}`;
    const thread = this.thread;
    const turnRelease = this.turns.reserve(8 * 1024 * 1024);
    if (!turnRelease) return Promise.reject(new Error('Agent turn buffer capacity exhausted'));
    let requestRelease = this.requests.reserve(2 * thread.length + 512);
    if (!requestRelease) {
      turnRelease();
      return Promise.reject(new Error('Agent unanswered request capacity exhausted'));
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        const turn = this.pending?.turn;
        try {
          if (turn)
            this.send?.({
              id: `${id}:interrupt`,
              method: 'turn/interrupt',
              params: { threadId: thread, turnId: turn },
            });
          else if (requestRelease) {
            this.abandoned.set(id, { thread, release: requestRelease });
            requestRelease = null;
          }
        } catch {
          // A failed send is uncertain; never retry it from the abort listener.
        } finally {
          finish(new Error('Automated turn cancelled'));
        }
      };
      const finish = (error?: Error, reply?: string) => {
        if (this.pending?.id !== id) return;
        this.observations?.endRequest(id, error);
        for (const entry of this.pending.early) entry.release();
        this.pending.early = [];
        this.pending = null;
        signal.removeEventListener('abort', abort);
        turnRelease();
        requestRelease?.();
        requestRelease = null;
        if (error) reject(error);
        else resolve(reply ?? '');
      };
      this.pending = { id, thread, turn: null, reply: '', early: [], earlyBytes: 0, finish };
      this.busy = true;
      signal.addEventListener('abort', abort, { once: true });
      this.observations?.submit(id, thread, context);
      try {
        this.send!({
          id,
          method: 'turn/start',
          params: {
            threadId: thread,
            input: [{ type: 'text', text: prompt, text_elements: [] }],
            ...(outputSchema ? { outputSchema } : {}),
          },
        });
      } catch (error) {
        this.busy = false;
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** True means an injected RPC response, which the TUI must not receive. */
  server(message: RecordValue): boolean {
    this.observations?.server(message);
    const id = message['id'];
    const pending = this.pending;
    if (typeof id === 'string' && id.startsWith('puddlang:')) {
      const abandoned = this.abandoned.get(id);
      if (abandoned) {
        this.abandoned.delete(id);
        abandoned.release();
        const abandonedThread = abandoned.thread;
        const turn = record(record(message['result'])['turn']);
        if (validTurnId(turn['id'])) {
          try {
            this.send?.({
              id: `${id}:interrupt`,
              method: 'turn/interrupt',
              params: { threadId: abandonedThread, turnId: turn['id'] },
            });
          } catch {
            // The ask already failed. Keep native transport alive; never replay
            // an uncertain control command or claim that interruption succeeded.
            this.disconnect();
          }
        } else if (typeof turn['id'] === 'string') this.disconnect();
        else if (abandonedThread === this.thread) this.busy = false;
      }
      if (pending?.id === id) {
        const turn = record(record(message['result'])['turn']);
        if (message['error'] || !validTurnId(turn['id'])) {
          this.busy = false;
          pending.finish(
            new Error(diagnostic(record(message['error'])['message'], 'Agent rejected the turn')),
          );
        } else {
          pending.turn = turn['id'];
          this.busy = turn['status'] === 'inProgress';
          const early = pending.early;
          pending.early = [];
          try {
            for (const entry of early) {
              if (this.pending !== pending) break;
              this.observe(entry.value);
            }
          } finally {
            for (const entry of early) entry.release();
          }
        }
      }
      return true;
    }
    const params = record(message['params']);
    if (params['threadId'] !== this.thread) return false;
    if (message['method'] === 'turn/started') this.busy = true;
    if (message['method'] === 'turn/completed') this.busy = false;
    if (
      pending &&
      pending.turn === null &&
      (message['method'] === 'item/completed' || message['method'] === 'turn/completed')
    ) {
      try {
        pending.earlyBytes += runtimeJsonBytes(message);
      } catch {
        pending.finish(new Error('Agent reply exceeded the bounded event buffer'));
        return false;
      }
      if (pending.early.length >= 256 || pending.earlyBytes > 1024 * 1024)
        pending.finish(new Error('Agent reply exceeded the bounded event buffer'));
      else {
        let release: (() => void) | null;
        try {
          release = this.earlyEvents.reserve(runtimeJsonRetainedBytes(message));
        } catch {
          release = null;
        }
        if (!release) pending.finish(new Error('Agent reply metadata capacity exhausted'));
        else pending.early.push({ value: message, release });
      }
    } else this.observe(message);
    return false;
  }

  private observe(message: RecordValue): void {
    const p = this.pending;
    if (!p?.turn) return;
    const params = record(message['params']);
    if (params['threadId'] !== p.thread) return;
    const turn = record(params['turn']);
    const turnId = params['turnId'] ?? turn['id'];
    if (turnId !== p.turn) return;
    const take = (item: unknown) => {
      const value = record(item);
      if (
        value['type'] === 'agentMessage' &&
        typeof value['text'] === 'string' &&
        value['phase'] !== 'commentary'
      )
        p.reply = value['text'];
    };
    if (message['method'] === 'item/completed') take(params['item']);
    if (Buffer.byteLength(p.reply) > 256 * 1024) {
      p.finish(new Error('Agent reply exceeds 256 KiB'));
      return;
    }
    if (message['method'] !== 'turn/completed') return;
    this.busy = false;
    if (Array.isArray(turn['items'])) turn['items'].forEach(take);
    if (turn['status'] !== 'completed')
      p.finish(
        new Error(
          `Agent turn ${diagnostic(turn['status'], 'failed')}: ${diagnostic(record(turn['error'])['message'], '')}`,
        ),
      );
    else if (!p.reply || Buffer.byteLength(p.reply) > 256 * 1024)
      p.finish(new Error('The completed turn has no bounded final reply'));
    else p.finish(undefined, p.reply);
  }
}
