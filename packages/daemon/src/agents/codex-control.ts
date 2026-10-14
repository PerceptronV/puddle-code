import { randomUUID } from 'node:crypto';
import type { AgentControl } from './adapter.js';

type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as RecordValue) : {};

/** Exact turn control on the TUI's existing connection; Codex 0.159.0 schema. */
export class CodexControl implements AgentControl {
  private send: ((message: RecordValue) => void) | null = null;
  private thread: string | null = null;
  private busy = false;
  private readonly abandoned = new Map<string, string>();
  private pending: {
    id: string;
    thread: string;
    turn: string | null;
    reply: string;
    early: RecordValue[];
    earlyBytes: number;
    finish(error?: Error, reply?: string): void;
  } | null = null;

  get ready(): boolean {
    return this.send !== null && this.thread !== null && !this.busy && !this.pending;
  }

  connect(send: (message: RecordValue) => void): void {
    this.disconnect();
    this.send = send;
  }

  bind(thread: string): void {
    if (this.thread !== thread) {
      this.pending?.finish(new Error('The agent changed its native conversation'));
      this.thread = thread;
      this.busy = false;
    }
  }

  disconnect(): void {
    this.pending?.finish(new Error('The agent control connection closed'));
    this.send = null;
    this.thread = null;
    this.busy = false;
    this.abandoned.clear();
  }

  /** Human turns and native switches cannot be attributed to a scripted ask. */
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
      this.pending?.finish(new Error('Human or native input interrupted the scripted turn'));
      if (method === 'turn/start') this.busy = true;
    }
  }

  ask(prompt: string, signal: AbortSignal, outputSchema?: RecordValue): Promise<string> {
    if (!this.ready || !this.thread || !this.send)
      return Promise.reject(new Error('Agent is busy or not ready'));
    signal.throwIfAborted();
    const id = `puddlang:${randomUUID()}`;
    const thread = this.thread;
    return new Promise((resolve, reject) => {
      const abort = () => {
        const turn = this.pending?.turn;
        if (turn)
          this.send?.({
            id: `${id}:interrupt`,
            method: 'turn/interrupt',
            params: { threadId: thread, turnId: turn },
          });
        else this.abandoned.set(id, thread);
        finish(new Error('Scripted turn cancelled'));
      };
      const finish = (error?: Error, reply?: string) => {
        if (this.pending?.id !== id) return;
        this.pending = null;
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(reply ?? '');
      };
      this.pending = { id, thread, turn: null, reply: '', early: [], earlyBytes: 0, finish };
      this.busy = true;
      signal.addEventListener('abort', abort, { once: true });
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
    const id = message['id'];
    const pending = this.pending;
    if (typeof id === 'string' && id.startsWith('puddlang:')) {
      const abandonedThread = this.abandoned.get(id);
      if (abandonedThread) {
        this.abandoned.delete(id);
        const turn = record(record(message['result'])['turn']);
        if (typeof turn['id'] === 'string')
          this.send?.({
            id: `${id}:interrupt`,
            method: 'turn/interrupt',
            params: { threadId: abandonedThread, turnId: turn['id'] },
          });
        else if (abandonedThread === this.thread) this.busy = false;
      }
      if (pending?.id === id) {
        const turn = record(record(message['result'])['turn']);
        if (message['error'] || typeof turn['id'] !== 'string') {
          this.busy = false;
          pending.finish(
            new Error(String(record(message['error'])['message'] ?? 'Agent rejected the turn')),
          );
        } else {
          pending.turn = turn['id'];
          this.busy = turn['status'] === 'inProgress';
          for (const event of pending.early) this.observe(event);
          pending.early = [];
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
      pending.earlyBytes += Buffer.byteLength(JSON.stringify(message));
      if (pending.early.length >= 256 || pending.earlyBytes > 1024 * 1024)
        pending.finish(new Error('Agent reply exceeded the bounded event buffer'));
      else pending.early.push(message);
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
          `Agent turn ${String(turn['status'])}: ${String(record(turn['error'])['message'] ?? '')}`,
        ),
      );
    else if (!p.reply || Buffer.byteLength(p.reply) > 256 * 1024)
      p.finish(new Error('The completed turn has no bounded final reply'));
    else p.finish(undefined, p.reply);
  }
}
