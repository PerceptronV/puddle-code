import { RUNTIME_LIMITS, type RuntimeEvent, type WsServerMessage } from '@puddle/shared';
import type { RuntimeStore, RuntimeSegmentBinding } from '../db/stores/runtimes.js';
import type { RuntimeObservationStore } from '../db/stores/runtime-observations.js';
import { ApiError } from '../http/errors.js';
import type { RuntimeClient } from './client.js';
import { RuntimeConnections, runtimeBindingIdentity } from './connections.js';
import { readRuntimeCheckpoint } from './segments.js';
import { runtimeDirectory } from './storage.js';

type Address = RuntimeSegmentBinding & { generation: string; term: string };
interface Viewer {
  valid(): boolean;
  send(message: WsServerMessage): void;
  reconnect(): void;
}
const unavailable = () =>
  ApiError.conflict(
    'runtime_unavailable',
    'The runtime terminal changed or is unavailable. Reconnect before sending more input.',
  );

/** Multiplex private owner events; viewers retain exact immutable addresses. */
export class RuntimeTerminals {
  private readonly views = new Set<RuntimeTerminalView>();
  constructor(
    private readonly home: string,
    readonly runtimes: RuntimeStore,
    readonly connections: RuntimeConnections,
    readonly observations: RuntimeObservationStore,
  ) {
    connections.on('connected', (id: string, client: RuntimeClient) => {
      const listen = (event: RuntimeEvent) => {
        for (const view of this.views)
          if (view.address.runtime_id === id && view.client === client) view.event(event);
      };
      client.on('event', listen);
      client.once('disconnected', () => client.off('event', listen));
    });
    connections.on('disconnected', (id: string) => {
      for (const view of [...this.views])
        if (view.address.runtime_id === id && view.client) view.invalidate();
    });
  }

  hasSession(sessionId: string): boolean {
    return this.runtimes.usesExternalTerminals(sessionId) || !!this.runtimes.ownerOf(sessionId);
  }

  open(sessionId: string, term: string, viewer: Viewer): RuntimeTerminalView {
    const segment = this.runtimes.terminalForPlacement(sessionId, term);
    if (!segment) throw unavailable();
    const binding = this.runtimes.get(segment.runtime_id)!;
    const current =
      binding.active_session_id === sessionId &&
      binding.active_segment_id === segment.segment_id &&
      ['prepared', 'running'].includes(binding.state);
    const client = current ? this.connections.get(binding.runtime_id) : null;
    if (current && !client) throw unavailable();
    const view = new RuntimeTerminalView(this, { ...segment, term }, client, viewer);
    this.views.add(view);
    return view;
  }

  remove(view: RuntimeTerminalView): void {
    this.views.delete(view);
  }

  async notificationOutput(sessionId: string, attentionId: string): Promise<string> {
    const owner = this.runtimes.selectedOwner(sessionId);
    if (!owner || owner.active_session_id !== sessionId || !owner.active_segment_id) return '';
    const client = this.connections.get(owner.runtime_id);
    if (!client) return '';
    const response = await client.request({
      t: 'attention-preview',
      attention_id: attentionId,
      placement: { session_id: sessionId, segment_id: owner.active_segment_id },
    });
    return response.t === 'attention-preview' && response.attention_id === attentionId
      ? response.text
      : '';
  }

  async checkpoint(address: Address): Promise<string> {
    const binding = this.runtimes.get(address.runtime_id);
    if (!binding) throw unavailable();
    const snapshot = await readRuntimeCheckpoint(
      runtimeDirectory(this.home, binding.runtime_id),
      runtimeBindingIdentity(binding),
      address.segment_id,
      address.term,
      address.generation,
    );
    if (
      snapshot.segment.start_cursor !== address.start_cursor ||
      (address.end_cursor !== null && snapshot.through > address.end_cursor)
    )
      throw unavailable();
    return snapshot.data;
  }
}

/** One authorised viewer, with bounded replay buffering and no command replay. */
export class RuntimeTerminalView {
  private closed = false;
  private ready = false;
  private ended = false;
  private mutationTail: Promise<void> = Promise.resolve();
  private pendingMutations = 0;
  private inputBytes = 0;
  private through = -1;
  private queued: Array<Extract<RuntimeEvent, { t: 'output' | 'exit' }>> = [];
  private queuedBytes = 0;
  private output: string[] = [];
  private outputChars = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly owner: RuntimeTerminals,
    readonly address: Address,
    readonly client: RuntimeClient | null,
    private readonly viewer: Viewer,
  ) {
    this.ended =
      owner.observations
        .get(address.runtime_id)
        ?.terminals.find(
          (term) => term.term === address.term && term.generation === address.generation,
        )?.pid === null;
  }

  private valid(): boolean {
    return !this.closed && this.viewer.valid();
  }

  async start(cols: number, rows: number): Promise<void> {
    let data: string;
    if (this.client) {
      const response = await this.client.request({
        t: 'snapshot',
        term: this.address.term,
        generation: this.address.generation,
      });
      if (
        response.t !== 'snapshot' ||
        response.segment_id !== this.address.segment_id ||
        response.generation !== this.address.generation
      ) {
        this.invalidate();
        return;
      }
      this.through = response.cursor;
      data = response.data;
    } else data = await this.owner.checkpoint(this.address);
    if (!this.valid()) return;
    this.viewer.send({
      t: 'replay',
      session: this.address.session_id,
      term: this.address.term,
      data,
    });
    this.ready = true;
    for (const event of this.queued) if (event.cursor > this.through) this.deliver(event);
    this.queued = [];
    this.queuedBytes = 0;
    if (
      this.client &&
      !this.ended &&
      this.owner.observations
        .get(this.address.runtime_id)
        ?.terminals.some(
          (term) =>
            term.term === this.address.term &&
            term.generation === this.address.generation &&
            term.pid !== null,
        )
    )
      await this.resize(cols, rows);
  }

  event(event: RuntimeEvent): void {
    if (!this.valid()) {
      this.dispose();
      return;
    }
    if (
      (event.t === 'native-lifecycle' && event.previous_segment_id !== null) ||
      (event.t === 'terminal-created' &&
        event.terminal.term === this.address.term &&
        event.terminal.generation !== this.address.generation)
    ) {
      this.invalidate();
      return;
    }
    if (event.t !== 'output' && event.t !== 'exit') return;
    if (
      event.term !== this.address.term ||
      event.generation !== this.address.generation ||
      (event.t === 'output' && event.segment_id !== this.address.segment_id)
    )
      return;
    if (event.t === 'exit') this.ended = true;
    if (!this.ready) {
      this.queuedBytes += event.t === 'output' ? Buffer.byteLength(event.data) : 64;
      if (this.queuedBytes > 2 * 1024 * 1024 || this.queued.length >= 4096) {
        this.invalidate();
        return;
      }
      this.queued.push(event);
    } else if (event.cursor > this.through) this.deliver(event);
  }

  private deliver(event: Extract<RuntimeEvent, { t: 'output' | 'exit' }>): void {
    this.through = event.cursor;
    if (event.t === 'exit') {
      this.flush();
      if (this.valid())
        this.viewer.send({
          t: 'exit',
          session: this.address.session_id,
          term: this.address.term,
          code: event.exit_code,
        });
      return;
    }
    this.output.push(event.data);
    this.outputChars += event.data.length;
    if (this.outputChars >= 64 * 1024) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 16);
      this.timer.unref();
    }
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.output.length && this.valid())
      this.viewer.send({
        t: 'output',
        session: this.address.session_id,
        term: this.address.term,
        data: this.output.join(''),
      });
    this.output = [];
    this.outputChars = 0;
  }

  private mutable(): RuntimeClient {
    const binding = this.owner.runtimes.get(this.address.runtime_id);
    if (
      !this.valid() ||
      !this.ready ||
      this.ended ||
      !this.client ||
      this.owner.connections.get(this.address.runtime_id) !== this.client ||
      binding?.active_session_id !== this.address.session_id ||
      binding.active_segment_id !== this.address.segment_id ||
      !['prepared', 'running'].includes(binding.state)
    )
      throw unavailable();
    return this.client;
  }

  private mutate(bytes: number, action: () => Promise<void>): Promise<void> {
    this.mutable();
    if (
      this.pendingMutations >= RUNTIME_LIMITS.pendingRequests ||
      this.inputBytes + bytes > RUNTIME_LIMITS.queuedBytes
    ) {
      this.invalidate();
      return Promise.reject(unavailable());
    }
    this.pendingMutations++;
    this.inputBytes += bytes;
    const pending = this.mutationTail
      .then(async () => {
        this.mutable();
        await action();
      })
      .catch((error: unknown) => {
        this.invalidate();
        throw error;
      })
      .finally(() => {
        this.pendingMutations--;
        this.inputBytes -= bytes;
      });
    this.mutationTail = pending.catch(() => {});
    return pending;
  }

  async input(data: string): Promise<void> {
    await this.mutate(Buffer.byteLength(data), async () => {
      const bytes = Buffer.from(data);
      for (let offset = 0; offset < bytes.length;) {
        let end = Math.min(offset + RUNTIME_LIMITS.inputBytes, bytes.length);
        // Split only between UTF-8 characters; each admitted chunk is bounded.
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
        await this.mutable().request({
          t: 'input',
          placement: { session_id: this.address.session_id, segment_id: this.address.segment_id },
          term: this.address.term,
          generation: this.address.generation,
          data: bytes.subarray(offset, end).toString('utf8'),
          source: 'human',
        });
        offset = end;
      }
    });
  }

  async resize(cols: number, rows: number): Promise<void> {
    await this.mutate(0, async () => {
      await this.mutable().request({
        t: 'resize',
        placement: { session_id: this.address.session_id, segment_id: this.address.segment_id },
        term: this.address.term,
        generation: this.address.generation,
        cols,
        rows,
      });
    });
  }

  async kill(): Promise<void> {
    if (this.address.term === 'agent') throw unavailable();
    await this.mutate(0, async () => {
      await this.mutable().request({
        t: 'kill-terminal',
        placement: {
          session_id: this.address.session_id,
          segment_id: this.address.segment_id,
        },
        term: this.address.term,
        generation: this.address.generation,
      });
    });
  }

  invalidate(): void {
    if (this.closed) return;
    this.dispose();
    this.viewer.reconnect();
  }

  dispose(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.output = [];
    this.queued = [];
    this.owner.remove(this);
  }
}
