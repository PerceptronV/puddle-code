import { timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server, Socket } from 'node:net';
import {
  RUNTIME_LIMITS,
  RUNTIME_PROTOCOL_VERSION,
  compatibleRuntimeProtocol,
  runtimeRequestSchema,
  runtimeRetainedEventSchema,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeLaunch,
  type RuntimeRequest,
  type RuntimeResponse,
  type RuntimeState,
  type RuntimeTerminal,
  type RuntimePlacement,
  type RuntimePlacementBinding,
} from '@puddle/shared';
import { ipcPath, listenPrivate } from '@puddle/shared/node';
import { LogStore } from '../logs/log-store.js';
import {
  PtyManager,
  type PtyDataEvent,
  type PtyExitEvent,
  type PtyEnvDeltaEvent,
  type PtyCwdEvent,
} from '../pty/pty-manager.js';
import { readRuntimeFrames, writeRuntimeFrame } from './transport/framing.js';
import { RuntimeRequestQueue } from './transport/requests.js';
import { runtimeJsonRetainedBytes } from './transport/encoding.js';
import { RuntimeBufferBudget } from './resources/budget.js';
import { readRuntimeController } from './ownership/storage.js';
import { RuntimeOwnerMemory } from './resources/host/owner.js';
import { RuntimeTransportBuffers } from './transport/buffers.js';
import { RuntimeJournal, type RuntimeJournalReservation } from './state/journal.js';
import { RuntimeStateFile } from './state/snapshot.js';
import { RuntimeTurns, RuntimeTurnError } from './execution/turns.js';
import { RuntimeAgent } from './execution/agent.js';
import { AdapterRegistry } from '../agents/registry.js';
import { defaultAdapters } from '../agents/defaults.js';
import { RuntimeObservations } from './state/observations.js';
import { RuntimeSegments } from './state/segments.js';
import { TerminalTheme } from '../pty/terminal-theme.js';
import { RuntimeAttentionState } from './state/attention.js';
import { TerminalAgentMonitor } from '../sessions/terminal-agent-monitor.js';
import { TerminalProcessReader } from '../pty/foreground-process.js';
import { RuntimeTitles } from './state/titles.js';
import { prepareRuntimeLifetime } from './lifecycle/lifetime.js';

/** One process owns one runtime. No application database or public HTTP server. */
export class RuntimeHost {
  private readonly terminals = new Map<string, RuntimeTerminal>();
  private readonly pendingSpawns = new Set<string>();
  private readonly sockets = new Set<Socket>();
  private readonly requests: RuntimeBufferBudget;
  private readonly transport: RuntimeTransportBuffers;
  private readonly readWork: RuntimeBufferBudget;
  private owner: { socket: Socket; id: string; epoch: number; offeredThrough: number } | null =
    null;
  private eventCursor = 0;
  private commandCursor = 0;
  private status: RuntimeState['state'] = 'prepared';
  private persistencePending = false;
  private consumed = false;
  private server: Server | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly logs: LogStore;
  private readonly ptys: PtyManager;
  private readonly claim: { release(): void };
  private readonly directory: string;
  private readonly journal: RuntimeJournal;
  private readonly stateFile: RuntimeStateFile;
  private readonly turns: RuntimeTurns;
  private readonly observations: RuntimeObservations;
  private readonly segments: RuntimeSegments;
  private readonly theme = new TerminalTheme();
  private readonly attention = new RuntimeAttentionState((attention) =>
    this.event({ t: 'attention-state', cursor: ++this.eventCursor, attention }),
  );
  private expectedExit = false;
  private terminalAgents: TerminalAgentMonitor | null = null;
  private terminalProcesses: TerminalProcessReader | null = null;
  private readonly titles = new RuntimeTitles();
  private binding: RuntimePlacementBinding | null;
  private agent: RuntimeAgent | null = null;
  private releaseLifetime: (() => void) | null = null;
  private closingAgent: Promise<void> | null = null;
  readonly launch: RuntimeLaunch;

  private constructor(
    private readonly home: string,
    private readonly build: string,
    private readonly memory: RuntimeOwnerMemory,
  ) {
    this.directory = memory.directory;
    this.claim = memory.claim;
    this.requests = new RuntimeBufferBudget(
      { bytes: 64 * 1024 * 1024, count: RUNTIME_LIMITS.pendingRequests },
      memory.allowance,
    );
    this.transport = new RuntimeTransportBuffers(memory.allowance);
    this.readWork = new RuntimeBufferBudget(
      { bytes: 2 * RUNTIME_READ_WORK_BYTES, count: 2 },
      memory.allowance,
    );
    try {
      this.launch = memory.launch;
      this.binding = {
        segment_id: this.launch.identity.runtime_id,
        session_id: this.launch.identity.session_id,
        through: 0,
      };
      this.observations = new RuntimeObservations(this.launch.capture_env);
      if (this.launch.theme) this.theme.set(this.launch.theme.fg, this.launch.theme.bg);
      this.stateFile = new RuntimeStateFile(this.directory);
      this.journal = new RuntimeJournal(this.directory, this.launch.identity);
      this.turns = new RuntimeTurns(this.journal, (event, reservation) => {
        this.event({ ...event, cursor: ++this.eventCursor }, reservation);
        if (event.t === 'turn-finished') this.persistState();
      });
      // Health callbacks also report successful saves. Only latch failures; one
      // writer's success must not clear another writer's unresolved failure.
      const persistenceHealth = (degraded: boolean) => {
        if (degraded) this.persistencePending = true;
      };
      this.logs = new LogStore(
        join(this.directory, 'logs'),
        256 * 1024,
        10 * 1024 * 1024,
        persistenceHealth,
        memory.allowance,
      );
      this.segments = new RuntimeSegments(
        this.directory,
        this.launch.identity,
        this.logs,
        this.launch.provider?.resume_ref ?? this.launch.provider?.initial_ref ?? null,
        { allowance: memory.allowance },
      );
      this.ptys = new PtyManager(
        this.logs,
        this.theme,
        join(this.directory, 'screens'),
        persistenceHealth,
        memory.allowance,
      );
      this.ptys.on('data', (event: PtyDataEvent) => this.output(event));
      this.ptys.on('exit', (event: PtyExitEvent) => this.exited(event));
      this.ptys.on('env-delta', (event: PtyEnvDeltaEvent) => this.environment(event));
      this.ptys.on('cwd', (event: PtyCwdEvent) => this.cwd(event));
    } catch (error) {
      try {
        this.memory.close();
      } finally {
        this.claim.release();
      }
      throw error;
    }
  }

  static async start(
    home: string,
    id: string,
    build: string,
    adapters = new AdapterRegistry(defaultAdapters),
  ): Promise<RuntimeHost> {
    const memory = await RuntimeOwnerMemory.open(home, id);
    const host = new RuntimeHost(home, build, memory);
    try {
      host.releaseLifetime = await prepareRuntimeLifetime(home, host.launch);
      host.server = await listenPrivate(ipcPath(home, `runtime:${id}`), (socket) =>
        host.accept(socket),
      );
      // A supervisor or uncertain launcher must never replay a consumed command,
      // even after its original owner died before reporting successful startup.
      const fd = openSync(join(host.directory, 'consumed.json'), 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ format: 1, identity: host.launch.identity }));
        fsyncSync(fd);
        host.consumed = true;
      } finally {
        closeSync(fd);
      }
      if (!(await host.journal.flush()))
        throw new Error('Could not initialise runtime event journal');
      let command = host.launch.main;
      if (host.launch.provider) {
        let lastStatus: string | undefined;
        const providerLaunch = {
          ...host.launch,
          main: {
            ...host.launch.main,
            env: {
              ...host.launch.environment,
              ...host.observations.environment(),
              ...host.launch.main.env,
            },
          },
        };
        host.agent = new RuntimeAgent(
          home,
          providerLaunch,
          adapters.get(host.launch.provider.id),
          {
            writeInput: (data) => host.ptys.write(id, 'agent', data, 'script'),
            screen: () => host.ptys.statusOutput(id),
            lifecycle: (lifecycle) => {
              host.turns.lifecycle(lifecycle);
              const cursor = ++host.eventCursor;
              const binding = host.segments.lifecycle(
                lifecycle,
                cursor,
                [...host.terminals.values()],
                (term, accept) => host.capture(term, accept),
              );
              if (binding.previous_segment_id !== null) {
                host.binding = null;
                host.titles.reset();
              }
              host.event({ t: 'native-lifecycle', cursor, lifecycle, ...binding });
              if (binding.previous_segment_id !== null) host.attention.clear();
              host.persistState();
            },
            state: (agent) => {
              host.event({ t: 'agent-state', cursor: ++host.eventCursor, agent });
              if (agent.status !== lastStatus) {
                lastStatus = agent.status;
                if (agent.status === 'waiting_input' && !host.expectedExit)
                  host.attention.waiting(host.segments.state().current.id);
                else host.attention.clear();
              }
            },
            collision: (ref) => {
              host.event({
                t: 'native-collision',
                cursor: ++host.eventCursor,
                agent_session_ref: ref,
              });
              queueMicrotask(() => {
                void host.stop();
              });
            },
          },
          memory.allowance,
        );
        command = await host.agent.prepare();
        const agent = host.agent.state();
        host.ptys.registerSidecars(id, agent.sidecar_pids, agent.hidden_ports);
      }
      await host.spawn('agent', command);
      if (!host.launch.provider) host.monitorTerminal(adapters);
      host.status = 'running';
      host.persistState();
      return host;
    } catch (error) {
      host.status = 'failed';
      await host.stop();
      throw error;
    }
  }

  state(): RuntimeState {
    return {
      identity: this.launch.identity,
      protocol: RUNTIME_PROTOCOL_VERSION,
      build: this.build,
      lifetime: this.launch.lifetime ?? 'unknown',
      state: this.status,
      terminals: [...this.terminals.values()].map((term) => ({ ...term })),
      event_cursor: this.eventCursor,
      command_cursor: this.commandCursor,
      persistence_pending: this.persistencePending || this.journal.status().persistence_pending,
      journal: this.journal.status(),
      agent: this.agent?.state() ?? null,
      turn: this.turns.state(),
      environment: this.observations.state(),
      theme: this.theme.colours(),
      attention: this.attention.get(),
      terminal_agent:
        this.terminalAgents?.get(
          this.launch.identity.runtime_id,
          this.launch.identity.runtime_id,
        ) ?? null,
      history: this.segments.state(),
      binding: this.binding ? { ...this.binding } : null,
    };
  }

  private persistState(): void {
    // A refused relaunch must not replace the original owner's final record.
    if (!this.consumed) return;
    try {
      this.stateFile.write(this.state());
    } catch {
      this.persistencePending = true;
    }
  }

  private async spawn(
    term: string,
    command: RuntimeCommand,
    authorised = () => true,
  ): Promise<void> {
    if (this.pendingSpawns.has(term)) throw new Error('Terminal launch is already pending');
    const current = this.terminals.get(term);
    if (current?.pid !== null && current !== undefined) throw new Error('Terminal already running');
    if (!current && this.terminals.size >= RUNTIME_LIMITS.terminals)
      throw new Error('Runtime terminal limit reached');
    const terminal: RuntimeTerminal = {
      term,
      generation: randomUUID(),
      pid: null,
      exit_code: null,
      cols: command.cols,
      rows: command.rows,
    };
    this.pendingSpawns.add(term);
    this.terminals.set(term, terminal);
    const stream = this.launch.identity.runtime_id;
    try {
      await this.ptys.spawnPrepared(
        stream,
        term,
        command.file,
        command.args,
        {
          cwd: command.cwd,
          // Command env contains adapter/hook overrides, not a stale captured map.
          // Captured values override the recorded daemon baseline; PtyManager adds
          // the owner's process environment underneath these explicit layers.
          env: { ...this.launch.environment, ...this.observations.environment(), ...command.env },
          record: false,
        },
        { cols: command.cols, rows: command.rows },
        () => !this.stopPromise && this.terminals.get(term) === terminal && authorised(),
      );
    } catch (error) {
      if (this.terminals.get(term) === terminal) {
        if (current) this.terminals.set(term, current);
        else this.terminals.delete(term);
      }
      throw error;
    } finally {
      this.pendingSpawns.delete(term);
    }
    terminal.pid = this.ptys.pidFor(stream, term);
    this.event({ t: 'terminal-created', cursor: ++this.eventCursor, terminal: { ...terminal } });
  }

  private output(event: PtyDataEvent): void {
    if (event.term === 'agent') {
      this.agent?.output(event.data);
      this.terminalAgents?.feed(this.launch.identity.runtime_id, event.data);
    }
    const terminal = this.terminals.get(event.term);
    if (!terminal) return;
    if (event.term === 'agent') {
      const title = this.titles.read(event.data);
      if (title !== null)
        this.event({
          t: 'osc-title',
          cursor: ++this.eventCursor,
          term: 'agent',
          generation: terminal.generation,
          segment_id: this.segments.state().current.id,
          title,
        });
    }
    this.segments.append(terminal, event.data);
    const segment_id = this.segments.state().current.id;
    if (Buffer.byteLength(event.data) <= RUNTIME_LIMITS.outputBytes) {
      this.event({
        t: 'output',
        cursor: ++this.eventCursor,
        term: event.term,
        generation: terminal.generation,
        segment_id,
        data: event.data,
      });
      return;
    }
    // PTY chunks are small in practice, but the wire bound is independent of
    // node-pty's platform chunk size. Slice by code points to retain Unicode.
    let data = '';
    let bytes = 0;
    const send = () => {
      if (!data) return;
      this.event({
        t: 'output',
        cursor: ++this.eventCursor,
        term: event.term,
        generation: terminal.generation,
        segment_id,
        data,
      });
      data = '';
      bytes = 0;
    };
    for (const character of event.data) {
      const length = Buffer.byteLength(character);
      if (bytes + length > RUNTIME_LIMITS.outputBytes) send();
      data += character;
      bytes += length;
    }
    send();
  }

  private environment(event: PtyEnvDeltaEvent): void {
    const terminal = this.terminals.get(event.term);
    if (!terminal) return;
    const delta = this.observations.observe(event.delta, (message) =>
      this.ptys.note(this.launch.identity.runtime_id, event.term, message),
    );
    if (delta)
      this.event({
        t: 'env-delta',
        cursor: ++this.eventCursor,
        term: event.term,
        generation: terminal.generation,
        delta,
      });
  }

  private cwd(event: PtyCwdEvent): void {
    const terminal = this.terminals.get(event.term);
    if (!terminal) return;
    const parsed = runtimeRetainedEventSchema.safeParse({
      t: 'cwd',
      cursor: this.eventCursor + 1,
      term: event.term,
      generation: terminal.generation,
      cwd: event.cwd,
    });
    if (!parsed.success) return;
    this.eventCursor++;
    this.event(parsed.data);
  }

  private exited(event: PtyExitEvent): void {
    const terminal = this.terminals.get(event.term);
    if (!terminal) return;
    terminal.pid = null;
    terminal.exit_code = event.exitCode;
    if (event.term === 'agent' && this.agent && !this.expectedExit)
      this.attention.exited(this.segments.state().current.id);
    if (event.term === 'agent' && this.terminalAgents) {
      if (!this.expectedExit) this.terminalAgents.exited(this.launch.identity.runtime_id);
      this.disposeTerminalMonitor();
    }
    if (event.term === 'agent') void this.closeAgent();
    this.event({
      t: 'exit',
      cursor: ++this.eventCursor,
      term: event.term,
      generation: terminal.generation,
      exit_code: event.exitCode,
    });
    this.segments.seal(this.eventCursor, [terminal], (term, accept) => this.capture(term, accept));
    if (this.ptys.liveCount() === 0 && this.status !== 'failed') this.status = 'exited';
    this.persistState();
    if (this.ptys.liveCount() === 0) void this.stop(false);
  }

  private event(event: RuntimeEvent, reservation?: RuntimeJournalReservation): void {
    if (
      event.t !== 'output' &&
      event.t !== 'agent-state' &&
      event.t !== 'attention-state' &&
      event.t !== 'terminal-agent-state'
    ) {
      if (reservation) reservation.append(event);
      else if (!this.journal.append(event)) return;
    }
    if (this.owner) this.reply(this.owner.socket, event);
  }

  private capture(term: RuntimeTerminal, accept?: (data: string) => void): Promise<string> {
    return this.ptys.canonicalSnapshot(
      this.launch.identity.runtime_id,
      term.term,
      term.cols,
      term.rows,
      accept,
    );
  }

  private monitorTerminal(adapters: AdapterRegistry): void {
    const id = this.launch.identity.runtime_id;
    const reader = new TerminalProcessReader();
    this.terminalProcesses = reader;
    this.terminalAgents = new TerminalAgentMonitor({
      adapters: adapters.list(),
      targets: () => {
        const pid = this.terminals.get('agent')?.pid;
        return pid == null ? [] : [{ session: id, runtime: id, pid }];
      },
      snapshot: async () => {
        const terminal = this.terminals.get('agent');
        if (terminal?.pid == null) return new Map();
        const { pid, generation } = terminal;
        const entries = await reader.read(pid, generation);
        const current = this.terminals.get('agent');
        return current?.pid === pid && current.generation === generation ? entries : new Map();
      },
      changed: () => {
        if (this.terminals.get('agent')?.pid != null) this.attention.clear();
        this.event({
          t: 'terminal-agent-state',
          cursor: ++this.eventCursor,
          agent: this.terminalAgents?.get(id, id) ?? null,
        });
      },
      activity: () => this.attention.clear(),
      notify: (_session, reason) => {
        if (this.expectedExit) return;
        const segment = this.segments.state().current.id;
        if (reason === 'waiting_input') this.attention.waiting(segment);
        else this.attention.exited(segment);
      },
    });
    void this.terminalAgents.refresh();
  }

  private disposeTerminalMonitor(): void {
    this.terminalAgents?.dispose();
    this.terminalAgents = null;
    this.terminalProcesses?.dispose();
    this.terminalProcesses = null;
  }

  private authorised(id: string, epoch: number): boolean {
    try {
      const current = readRuntimeController(this.home);
      return current.active && current.id === id && current.epoch === epoch;
    } catch {
      return false;
    }
  }

  private accept(socket: Socket): void {
    if (this.sockets.size >= 16 || this.stopPromise) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), RUNTIME_LIMITS.handshakeMs);
    const requests = new RuntimeRequestQueue(
      this.requests,
      () => !socket.destroyed,
      () => socket.destroy(),
    );
    const stop = readRuntimeFrames(
      socket,
      (value) => {
        const request = runtimeRequestSchema.parse(value);
        const bytes = runtimeJsonRetainedBytes(request);
        if (
          !requests.enqueue(bytes, async () => {
            try {
              await this.handle(socket, request);
            } catch (error) {
              this.reply(socket, {
                t: 'error',
                id: request.id,
                code: error instanceof RuntimeTurnError ? error.code : 'failed',
                message:
                  error instanceof RuntimeTurnError ? error.message : 'Runtime operation failed',
              });
            }
          })
        )
          socket.destroy();
      },
      () => socket.destroy(),
      this.transport.incoming,
      this.transport.decoding,
    );
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clearTimeout(timer);
      stop();
      this.sockets.delete(socket);
      if (this.owner?.socket === socket) this.owner = null;
    });
    // The handshake deadline is separate from a connection's idle lifetime.
    socket.on('runtime-authenticated', () => clearTimeout(timer));
  }

  private reply(socket: Socket, response: RuntimeResponse | RuntimeEvent): void {
    writeRuntimeFrame(socket, response, this.transport.outgoing, this.transport.encoding);
  }

  private currentPlacement(placement: RuntimePlacement): boolean {
    return (
      this.binding !== null &&
      placement.segment_id === this.binding.segment_id &&
      placement.session_id === this.binding.session_id
    );
  }

  private async handle(socket: Socket, request: RuntimeRequest): Promise<void> {
    const fail = (code: Extract<RuntimeResponse, { t: 'error' }>['code'], message: string) =>
      this.reply(socket, { t: 'error', id: request.id, code, message });
    if (request.t === 'hello') {
      if (!compatibleRuntimeProtocol(request.protocol)) {
        fail('incompatible', 'Unsupported runtime protocol');
        return;
      }
      const sameSecret = timingSafeEqual(
        Buffer.from(request.secret, 'hex'),
        Buffer.from(this.launch.secret, 'hex'),
      );
      if (
        !sameSecret ||
        request.runtime_id !== this.launch.identity.runtime_id ||
        request.incarnation !== this.launch.identity.incarnation ||
        !this.authorised(request.controller_id, request.controller_epoch)
      ) {
        fail('unauthorised', 'Runtime authority rejected');
        return;
      }
      if (this.owner?.socket !== socket) this.owner?.socket.destroy();
      this.owner = {
        socket,
        id: request.controller_id,
        epoch: request.controller_epoch,
        offeredThrough: 0,
      };
      socket.emit('runtime-authenticated');
      this.reply(socket, { t: 'state', id: request.id, state: this.state() });
      return;
    }
    const owner = this.owner;
    if (owner?.socket !== socket || !this.authorised(owner.id, owner.epoch)) {
      fail('fenced', 'Runtime controller is no longer current');
      return;
    }
    if (request.sequence <= this.commandCursor) {
      fail('duplicate_request', 'Runtime command was already admitted');
      return;
    }
    // Admission precedes effects, including errors: a lost acknowledgement can
    // never make an old sequence eligible again after controller reconnection.
    this.commandCursor = request.sequence;
    if ('placement' in request && !this.currentPlacement(request.placement)) {
      fail('stale_placement', 'Runtime placement changed or has not been committed');
      return;
    }
    const stream = this.launch.identity.runtime_id;
    if ('generation' in request && request.t !== 'segment-snapshot') {
      const term = this.terminals.get(request.term);
      if (!term || term.generation !== request.generation) {
        fail('stale_terminal', 'Terminal generation changed');
        return;
      }
      if (request.t !== 'snapshot' && term.pid === null) {
        fail('stale_terminal', 'Terminal has exited');
        return;
      }
    }
    switch (request.t) {
      case 'inspect':
        this.reply(socket, { t: 'state', id: request.id, state: this.state() });
        return;
      case 'attention-preview': {
        if (this.attention.get()?.id !== request.attention_id) {
          fail('result_unavailable', 'Runtime attention has changed');
          return;
        }
        const text = (await this.ptys.notificationOutput(stream)).slice(-4096);
        if (this.owner !== owner || !this.authorised(owner.id, owner.epoch)) {
          fail('fenced', 'Runtime controller is no longer current');
          return;
        }
        if (
          !this.currentPlacement(request.placement) ||
          this.attention.get()?.id !== request.attention_id
        ) {
          fail('result_unavailable', 'Runtime attention has changed');
          return;
        }
        this.reply(socket, {
          t: 'attention-preview',
          id: request.id,
          attention_id: request.attention_id,
          text,
        });
        return;
      }
      case 'theme':
        this.theme.set(request.colours.fg, request.colours.bg);
        this.persistState();
        this.reply(socket, { t: 'state', id: request.id, state: this.state() });
        return;
      case 'bind-placement': {
        const segment = this.segments.state().current;
        const binding = request.binding;
        if (
          binding.segment_id !== segment.id ||
          binding.through < segment.start_cursor ||
          binding.through > owner.offeredThrough ||
          this.journal.status().lost_through > 0
        ) {
          fail('stale_placement', 'Read and commit the current runtime segment before binding');
          return;
        }
        if (
          this.binding &&
          (this.binding.session_id !== binding.session_id || binding.through < this.binding.through)
        ) {
          fail('stale_placement', 'A committed runtime segment cannot change placement');
          return;
        }
        this.binding = { ...binding };
        this.persistState();
        this.reply(socket, { t: 'state', id: request.id, state: this.state() });
        return;
      }
      case 'capture-env':
      case 'clear-env': {
        if (this.stopPromise || !(await this.journal.flush())) {
          fail('busy', 'Runtime is stopping or event persistence is unavailable');
          return;
        }
        if (this.owner !== owner || !this.authorised(owner.id, owner.epoch)) {
          fail('fenced', 'Runtime controller is no longer current');
          return;
        }
        if (!this.currentPlacement(request.placement)) {
          fail('stale_placement', 'Runtime placement changed while admitting the command');
          return;
        }
        const reservation = this.stopPromise ? null : this.journal.reserve(256, 1);
        if (!reservation) {
          fail('busy', 'Runtime cannot retain an environment change');
          return;
        }
        try {
          if (request.t === 'capture-env') {
            this.observations.configure(request.enabled);
            this.event(
              { t: 'capture-env', cursor: ++this.eventCursor, enabled: request.enabled },
              reservation,
            );
          } else {
            const cleared = this.observations.state().count;
            this.observations.clear();
            this.event({ t: 'clear-env', cursor: ++this.eventCursor }, reservation);
            this.persistState();
            this.reply(socket, {
              t: 'env-cleared',
              id: request.id,
              cleared,
              through: this.eventCursor,
            });
            return;
          }
          this.persistState();
        } finally {
          reservation.release();
        }
        break;
      }
      case 'start-turn': {
        if (this.stopPromise || this.status !== 'running' || !(await this.journal.flush())) {
          fail('busy', 'Runtime is stopping or event persistence is unavailable');
          return;
        }
        if (this.owner !== owner || !this.authorised(owner.id, owner.epoch)) {
          fail('fenced', 'Runtime controller is no longer current');
          return;
        }
        if (!this.currentPlacement(request.placement)) {
          fail('stale_placement', 'Runtime placement changed while admitting the command');
          return;
        }
        if (this.stopPromise || this.status !== 'running') {
          fail('busy', 'Runtime is stopping');
          return;
        }
        const result = this.turns.start(
          this.agent?.control() ?? null,
          this.agent?.state().agent_session_ref ?? null,
          request,
        );
        this.persistState();
        this.reply(socket, { t: 'turn', id: request.id, result });
        return;
      }
      case 'turn-result':
        this.reply(socket, { t: 'turn', id: request.id, result: this.turns.result(request.turn) });
        return;
      case 'cancel-turn':
        this.turns.cancel(request.turn);
        break;
      case 'events': {
        await this.journal.flush();
        // Persistence may yield across controller replacement. A stale reader
        // cannot advance the new controller's acknowledgement boundary.
        if (this.owner !== owner || !this.authorised(owner.id, owner.epoch)) {
          fail('fenced', 'Runtime controller is no longer current');
          return;
        }
        const page = this.journal.read(request.after);
        if (!page.gap) owner.offeredThrough = Math.max(owner.offeredThrough, page.through);
        this.reply(socket, { t: 'events', id: request.id, page });
        return;
      }
      case 'ack-events':
        if (request.through > owner.offeredThrough) {
          fail('invalid_request', 'Runtime events must be read before acknowledgement');
          return;
        }
        this.journal.acknowledge(request.through);
        // This is safe to retry only after a fresh read: the database commit
        // precedes acknowledgement, and repeated cursors have no effects.
        await this.journal.flush();
        this.persistState();
        break;
      case 'snapshot': {
        const release = this.readWork.reserve(RUNTIME_READ_WORK_BYTES);
        if (!release) {
          fail('busy', 'Runtime snapshot memory capacity is exhausted');
          return;
        }
        try {
          // Capture before awaiting the emulator's existing write queue. Later
          // output is already streamed with a higher cursor and must be buffered
          // by the attaching reader until this snapshot arrives.
          const cursor = this.eventCursor;
          const segment_id = this.segments.state().current.id;
          const data = await this.ptys.canonicalSnapshot(stream, request.term);
          this.reply(socket, {
            t: 'snapshot',
            id: request.id,
            term: request.term,
            generation: request.generation,
            cursor,
            segment_id,
            data,
          });
          return;
        } finally {
          release();
        }
      }
      case 'segment-snapshot': {
        const release = this.readWork.reserve(RUNTIME_READ_WORK_BYTES);
        if (!release) {
          fail('busy', 'Runtime snapshot memory capacity is exhausted');
          return;
        }
        try {
          const checkpoint = await this.segments.read(
            request.segment_id,
            request.term,
            request.generation,
          );
          if (this.owner !== owner || !this.authorised(owner.id, owner.epoch)) {
            fail('fenced', 'Runtime controller is no longer current');
            return;
          }
          this.reply(socket, {
            t: 'segment-snapshot',
            id: request.id,
            checkpoint,
          });
          return;
        } finally {
          release();
        }
      }
      case 'input':
        if (Buffer.byteLength(request.data) > RUNTIME_LIMITS.inputBytes) {
          fail('invalid_request', 'Terminal input exceeds its byte limit');
          return;
        }
        if (request.term === 'agent' && request.source === 'human') {
          this.agent?.humanInput();
          this.turns.interrupt('Human input interrupted the automated turn');
        }
        this.ptys.write(stream, request.term, request.data, request.source);
        break;
      case 'resize': {
        this.ptys.resize(stream, request.term, request.cols, request.rows);
        Object.assign(this.terminals.get(request.term)!, {
          cols: request.cols,
          rows: request.rows,
        });
        break;
      }
      case 'spawn-shell':
        await this.spawn(
          request.term,
          request.command,
          () =>
            this.owner === owner &&
            !owner.socket.destroyed &&
            this.authorised(owner.id, owner.epoch) &&
            this.currentPlacement(request.placement),
        );
        this.persistState();
        break;
      case 'kill-terminal':
        if (request.term === 'agent') {
          this.expectedExit = true;
          this.attention.clear();
        }
        this.ptys.kill(stream, request.term);
        break;
      case 'stop':
        this.reply(socket, { t: 'ok', id: request.id });
        void this.stop();
        return;
    }
    this.reply(socket, { t: 'ok', id: request.id });
  }

  stop(expected = true): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.ptys.beginShutdown();
    if (expected) {
      this.expectedExit = true;
      this.attention.clear();
    }
    this.stopPromise = this.close();
    return this.stopPromise;
  }

  private closeAgent(): Promise<void> {
    if (!this.closingAgent) {
      this.turns.interrupt('Agent runtime exited before its turn completed');
      this.closingAgent = (this.agent?.close() ?? Promise.resolve())
        .catch(() => {
          this.status = 'failed';
        })
        .then(() => this.persistState());
    }
    return this.closingAgent;
  }

  private async close(): Promise<void> {
    try {
      this.disposeTerminalMonitor();
      this.ptys.killAll();
      const deadline = Date.now() + 3000;
      while (this.ptys.liveCount() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (this.ptys.liveCount()) this.ptys.killAll(undefined, 'SIGKILL');
      // Reap before closing the journal so final exit events cannot arrive after
      // it has been sealed or after a replacement daemon claims owner absence.
      while (this.ptys.liveCount()) await new Promise((resolve) => setTimeout(resolve, 20));
      await this.closeAgent();
      await this.segments.drain();
      await this.ptys.closeTerminalStates();
      this.logs.closeAll();
      // A refused relaunch must not rewrite the original journal either.
      if (this.consumed) await this.journal.close();
      if (this.status !== 'failed') this.status = 'exited';
      this.persistState();
      for (const socket of this.sockets) socket.destroy();
      if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    } finally {
      this.releaseLifetime?.();
      try {
        this.memory.close();
      } finally {
        this.claim.release();
      }
    }
  }
}

// Includes bounded file/JSON/response work until synchronous response encoding;
// transport retains its separate frame charge through socket write completion.
const RUNTIME_READ_WORK_BYTES = 8 * RUNTIME_LIMITS.frameBytes + 128 * 1024;
