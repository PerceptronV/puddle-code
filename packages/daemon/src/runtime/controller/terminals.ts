import { RUNTIME_LIMITS, type RuntimeEvent, type WsServerMessage } from '@puddle/shared';
import type { RuntimeStore, RuntimeSegmentBinding } from '../../db/stores/runtimes.js';
import type { RuntimeObservationStore } from '../../db/stores/runtime-observations.js';
import { ApiError } from '../../http/errors.js';
import type { RuntimeClient } from '../transport/client.js';
import { RuntimeConnections, runtimeBindingIdentity } from '../transport/connections.js';
import { readRuntimeCheckpoint } from '../state/segments.js';
import { runtimeDirectory } from '../ownership/storage.js';
import { isTerminalInteractionReport } from './terminals/interaction-report.js';
import {
  RuntimeTerminalBuffers,
  TERMINAL_SNAPSHOT_BYTES,
  terminalInputBytes,
  terminalOutputBytes,
} from './terminals/buffers.js';

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
    readonly buffers = new RuntimeTerminalBuffers(),
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
        if (view.address.runtime_id === id && view.client) view.disconnected();
    });
  }

  hasSession(sessionId: string): boolean {
    return this.runtimes.usesExternalTerminals(sessionId) || !!this.runtimes.ownerOf(sessionId);
  }

  detectedAgent(sessionId: string): string | null {
    const owner = this.runtimes.selectedOwner(sessionId);
    if (
      !owner ||
      owner.agent_type ||
      owner.active_session_id !== sessionId ||
      owner.state !== 'running'
    )
      return null;
    const state = this.connections.get(owner.runtime_id)?.state;
    return state?.binding?.session_id === sessionId &&
      state.binding.segment_id === owner.active_segment_id &&
      state.terminals.some((term) => term.term === 'agent' && term.pid !== null)
      ? (state.terminal_agent ?? null)
      : null;
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
  private started = false;
  private ended = false;
  private mutationTail: Promise<void> = Promise.resolve();
  private pendingMutations = 0;
  private inputBytes = 0;
  private through = -1;
  private queued: Array<{
    event: Extract<RuntimeEvent, { t: 'output' | 'exit' }>;
    release(): void;
  }> = [];
  private queuedBytes = 0;
  private output: Array<{ data: string; release(): void }> = [];
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

  disconnected(): void {
    // A completely restored terminal with a confirmed exit is already a
    // readable transcript. Its owner's normal shutdown must not disconnect
    // every other terminal sharing this browser socket.
    if (this.valid() && this.ready && this.ended) return;
    this.invalidate();
  }

  async start(cols: number, rows: number): Promise<void> {
    if (!this.valid()) {
      this.dispose();
      return;
    }
    if (this.started) return;
    this.started = true;
    const release = this.owner.buffers.snapshots.reserve(TERMINAL_SNAPSHOT_BYTES);
    if (!release) {
      this.invalidate();
      return;
    }
    try {
      await this.replay();
    } catch (error) {
      this.invalidate();
      throw error;
    } finally {
      // A disposed view still owns its pending read until it settles.
      release();
    }
    if (!this.valid()) return;
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

  private async replay(): Promise<void> {
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
    if (!this.valid()) {
      this.dispose();
      return;
    }
    this.viewer.send({
      t: 'replay',
      session: this.address.session_id,
      term: this.address.term,
      data,
    });
    if (!this.valid()) {
      this.dispose();
      return;
    }
    this.ready = true;
    // Keep reservations until this local array is no longer retained, including reentrant disposal.
    const queued = this.queued;
    this.queued = [];
    this.queuedBytes = 0;
    try {
      for (const { event } of queued) {
        if (!this.valid()) break;
        if (event.cursor > this.through) this.deliver(event);
      }
    } finally {
      for (const item of queued) item.release();
    }
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
      const release = this.owner.buffers.output.reserve(
        event.t === 'output' ? terminalOutputBytes(event.data) : 256,
      );
      if (!release) {
        this.invalidate();
        return;
      }
      this.queued.push({ event, release });
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
    const release = this.owner.buffers.output.reserve(terminalOutputBytes(event.data));
    if (!release) {
      this.invalidate();
      return;
    }
    this.output.push({ data: event.data, release });
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
    const output = this.output;
    this.output = [];
    this.outputChars = 0;
    try {
      if (output.length && this.valid())
        this.viewer.send({
          t: 'output',
          session: this.address.session_id,
          term: this.address.term,
          data: output.map((item) => item.data).join(''),
        });
    } catch {
      this.invalidate();
    } finally {
      for (const item of output) item.release();
    }
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

  private mutate(
    bytes: number,
    retainedBytes: number,
    action: () => Promise<void>,
    skipEnded = false,
    tolerateEndedFailure = false,
  ): Promise<void> {
    this.mutable();
    if (
      this.pendingMutations >= RUNTIME_LIMITS.pendingRequests ||
      this.inputBytes + bytes > RUNTIME_LIMITS.queuedBytes
    ) {
      this.invalidate();
      return Promise.reject(unavailable());
    }
    const release = this.owner.buffers.input.reserve(retainedBytes);
    if (!release) {
      this.invalidate();
      return Promise.reject(unavailable());
    }
    this.pendingMutations++;
    this.inputBytes += bytes;
    const pending = this.mutationTail
      .then(async () => {
        if (skipEnded && this.valid() && this.ended) return;
        this.mutable();
        await action();
      })
      .catch((error: unknown) => {
        if (tolerateEndedFailure && this.valid() && this.ended) return;
        this.invalidate();
        throw error;
      })
      .finally(() => {
        this.pendingMutations--;
        this.inputBytes -= bytes;
        release();
      });
    this.mutationTail = pending.catch(() => {});
    return pending;
  }

  async input(data: string): Promise<void> {
    // Restored xterm modes include focus and mouse reporting. Browsing a
    // transcript can emit these even though the user has typed nothing.
    // Only exact reports are harmless after exit; real input must still fail,
    // including mixed report/input messages and uncertain delivery.
    const interactionReport = isTerminalInteractionReport(data);
    if (interactionReport && this.valid() && this.ready && (this.ended || !this.client)) return;
    await this.mutate(
      Buffer.byteLength(data),
      terminalInputBytes(data),
      async () => {
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
      },
      interactionReport,
    );
  }

  async resize(cols: number, rows: number): Promise<void> {
    // Recorded/ended terminals remain readable and their browser pane can fit
    // locally. There is no live PTY whose geometry should be changed.
    if (this.valid() && (this.ended || !this.client)) return;
    await this.mutate(
      0,
      256,
      async () => {
        await this.mutable().request({
          t: 'resize',
          placement: { session_id: this.address.session_id, segment_id: this.address.segment_id },
          term: this.address.term,
          generation: this.address.generation,
          cols,
          rows,
        });
      },
      true,
      true,
    );
  }

  async kill(): Promise<void> {
    if (this.address.term === 'agent') throw unavailable();
    await this.mutate(0, 256, async () => {
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
    for (const item of this.output) item.release();
    for (const item of this.queued) item.release();
    this.output = [];
    this.queued = [];
    this.outputChars = 0;
    this.queuedBytes = 0;
    this.owner.remove(this);
  }
}
