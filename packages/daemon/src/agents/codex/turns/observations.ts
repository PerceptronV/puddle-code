import type { AgentNativeTurn, AgentTurnContext } from '@puddle/shared';
import type { LifecycleLaunchContext } from '../../adapter.js';
import {
  RuntimeBufferBudget,
  type RuntimeByteAllowance,
} from '../../../runtime/resources/budget.js';
import { runtimeJsonRetainedBytes } from '../../../runtime/transport/encoding.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096;
const reason = (value: unknown, fallback: string) =>
  typeof value === 'string' && value
    ? Buffer.from(value.slice(0, 4096)).toString('utf8')
    : fallback;
interface Request {
  thread: string;
  context?: AgentTurnContext;
  turn?: string;
  ended?: string;
  lost?: boolean;
  release(): void;
}
interface Turn {
  id: string;
  started: boolean;
  published: boolean;
  origin?: { automated: boolean; automation?: AgentTurnContext };
  reply: string;
  end?: { event: 'completed' | 'failed' | 'interrupted'; error?: string };
  release(): void;
}

/** Optional source retention, independent of essential ask/result admission. */
export class CodexTurnObservations {
  private thread: string | null = null;
  private uncertain = false;
  private readonly requests = new Map<string, Request>();
  private readonly turns = new Map<string, Turn>();
  private readonly retired = new Map<string, () => void>();
  private readonly requestBudget: RuntimeBufferBudget;
  private readonly turnBudget: RuntimeBufferBudget;
  private readonly retiredBudget: RuntimeBufferBudget;

  constructor(
    allowance: RuntimeByteAllowance | undefined,
    private readonly report: NonNullable<LifecycleLaunchContext['reportNativeTurn']>,
    private readonly gap: LifecycleLaunchContext['reportNativeTurnGap'],
  ) {
    this.requestBudget = new RuntimeBufferBudget({ bytes: 512 * 1024, count: 64 }, allowance);
    this.turnBudget = new RuntimeBufferBudget({ bytes: 8 * 1024 * 1024, count: 8 }, allowance);
    this.retiredBudget = new RuntimeBufferBudget({ bytes: 2 * 1024 * 1024, count: 128 }, allowance);
  }

  submit(id: string, thread: string, context?: AgentTurnContext): void {
    const release = this.requestBudget.reserve(
      runtimeJsonRetainedBytes({ id, thread, context }) + 512,
    );
    if (release)
      this.requests.set(id, {
        thread,
        context: context ? structuredClone(context) : undefined,
        release,
      });
    else {
      this.uncertain = true;
      this.loss(thread, `request:${id}`);
    }
  }

  endRequest(id: string, error?: Error): void {
    const request = this.requests.get(id);
    if (!request || !error) return;
    request.ended = reason(error.message, 'Automated turn ended');
    const turn = request.turn ? this.turns.get(request.turn) : undefined;
    if (turn && !turn.end) turn.end = { event: 'interrupted', error: request.ended };
    if (!request.turn) this.loss(request.thread, `request:${id}`);
    this.flush();
  }

  bind(thread: string): void {
    if (thread === this.thread) return;
    this.interrupt('Native conversation changed');
    for (const request of this.requests.values())
      if (request.thread === this.thread) request.lost = true;
    for (const turn of [...this.turns.values()]) {
      this.loss(this.thread!, turn.id);
      this.retire(turn);
    }
    this.thread = thread;
  }

  interrupt(error: string): void {
    for (const turn of this.turns.values())
      if (!turn.end) turn.end = { event: 'interrupted', error };
    this.flush();
  }

  disconnect(): void {
    this.interrupt('Native connection closed');
    if (this.requests.size) this.uncertain = true;
    for (const turn of [...this.turns.values()]) {
      if (this.thread) this.loss(this.thread, turn.id);
      this.retire(turn);
    }
    for (const request of this.requests.values()) request.release();
    this.requests.clear();
    for (const release of this.retired.values()) release();
    this.retired.clear();
    this.thread = null;
  }

  server(message: RecordValue): void {
    const id = message['id'];
    if (typeof id === 'string' && this.requests.has(id)) {
      const request = this.requests.get(id)!;
      const nativeId = record(record(message['result'])['turn'])['id'];
      if (
        message['error'] ||
        !validId(nativeId) ||
        request.lost ||
        request.thread !== this.thread
      ) {
        if (!message['error'] || (request.thread === this.thread && this.turns.size)) {
          this.uncertain = true;
          this.loss(request.thread, validId(nativeId) ? nativeId : `request:${id}`);
        }
        request.release();
        this.requests.delete(id);
      } else {
        request.turn = nativeId;
        const turn = this.obtain(nativeId);
        if (turn) {
          turn.started = true; // A correlated turn/start response proves admission too.
          turn.origin = {
            automated: true,
            ...(request.context ? { automation: request.context } : {}),
          };
          if (request.ended) turn.end = { event: 'interrupted', error: request.ended };
        } else {
          this.uncertain = true;
          request.release();
          this.requests.delete(id);
        }
      }
      this.flush();
      return;
    }
    const params = record(message['params']);
    if (!this.thread || params['threadId'] !== this.thread) return;
    const method = message['method'];
    if (!['turn/started', 'item/completed', 'turn/completed'].includes(String(method))) return;
    const native = record(params['turn']),
      nativeId = params['turnId'] ?? native['id'];
    if (!validId(nativeId)) {
      this.loss(this.thread, 'invalid-native-turn');
      return;
    }
    if (this.retired.has(`${this.thread}:${nativeId}`)) return;
    let turn = this.turns.get(nativeId);
    if (!turn && method !== 'turn/started' && !this.waiting()) {
      if (method === 'turn/completed') this.loss(this.thread, nativeId);
      return;
    }
    turn ??= this.obtain(nativeId) ?? undefined;
    if (!turn) return;
    if (method === 'turn/started') {
      for (const previous of this.turns.values())
        if (previous !== turn && !previous.end)
          previous.end = { event: 'interrupted', error: 'Another native turn started' };
      turn.started = true;
    }
    if (method === 'item/completed') this.take(turn, params['item']);
    if (method === 'turn/completed' && !turn.end) {
      if (Array.isArray(native['items'])) for (const item of native['items']) this.take(turn, item);
      turn.end ??=
        native['status'] === 'completed' && turn.reply
          ? { event: 'completed' }
          : {
              event: native['status'] === 'interrupted' ? 'interrupted' : 'failed',
              error: reason(
                record(native['error'])['message'],
                native['status'] === 'completed'
                  ? 'Native completion has no bounded final reply'
                  : 'Native turn did not complete successfully',
              ),
            };
    }
    this.flush();
  }

  private waiting(): boolean {
    return [...this.requests.values()].some(
      (request) => request.thread === this.thread && !request.turn,
    );
  }
  private obtain(id: string): Turn | null {
    const existing = this.turns.get(id);
    if (existing) return existing;
    if (this.retired.has(`${this.thread}:${id}`)) return null;
    const release = this.turnBudget.reserve(1024 * 1024);
    if (!release) {
      this.loss(this.thread!, id);
      return null;
    }
    const turn: Turn = { id, started: false, published: false, reply: '', release };
    this.turns.set(id, turn);
    return turn;
  }
  private take(turn: Turn, item: unknown): void {
    const value = record(item);
    if (
      value['type'] !== 'agentMessage' ||
      value['phase'] === 'commentary' ||
      typeof value['text'] !== 'string' ||
      turn.end
    )
      return;
    if (Buffer.byteLength(value['text']) > 256 * 1024)
      turn.end = { event: 'failed', error: 'Native reply exceeds 256 KiB' };
    else turn.reply = Buffer.from(value['text']).toString('utf8');
  }
  private flush(): void {
    for (const turn of [...this.turns.values()]) {
      if (!turn.origin) {
        if (this.waiting()) continue;
        turn.origin = { automated: this.uncertain };
      }
      if (turn.started && !turn.published) {
        turn.published = true;
        this.emit(turn, { event: 'started' });
      }
      if (!turn.end) continue;
      if (!turn.started) this.loss(this.thread!, turn.id);
      else
        this.emit(turn, {
          ...turn.end,
          ...(turn.end.event === 'completed' ? { reply: turn.reply } : {}),
        });
      this.retire(turn);
    }
  }
  private emit(turn: Turn, outcome: Pick<AgentNativeTurn, 'event' | 'reply' | 'error'>): void {
    try {
      this.report({
        ...outcome,
        ...turn.origin!,
        agentSessionRef: this.thread!,
        nativeTurnId: turn.id,
      });
    } catch {
      this.loss(this.thread!, turn.id);
    }
  }
  private retire(turn: Turn): void {
    this.turns.delete(turn.id);
    turn.release();
    for (const [id, request] of this.requests)
      if (request.thread === this.thread && request.turn === turn.id) {
        request.release();
        this.requests.delete(id);
      }
    const key = `${this.thread}:${turn.id}`;
    if (this.retired.size >= 128) {
      const first = this.retired.entries().next().value!;
      first[1]();
      this.retired.delete(first[0]);
    }
    const release = this.retiredBudget.reserve(2 * key.length + 256);
    if (release) this.retired.set(key, release);
    else {
      this.uncertain = true;
      this.loss(this.thread!, turn.id);
    }
  }
  private loss(ref: string, id: string): void {
    try {
      this.gap?.(ref, id);
    } catch {
      /* Observation failure does not own the PTY. */
    }
  }
}
