import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  RUNTIME_LIMITS,
  runtimeEventPageSchema,
  runtimeLaunchSchema,
  type RuntimeEventPage,
  type RuntimeJournalRecord,
  type RuntimeRetainedEvent,
  type RuntimeSegment,
  type RuntimeState,
  type RuntimeEvent,
  type RuntimeTheme,
} from '@puddle/shared';
import type { Db } from '../../db/db.js';
import type { RuntimeBinding, RuntimeStore } from '../../db/stores/runtimes.js';
import {
  RuntimeObservationStore,
  type RuntimeObservationState,
} from '../../db/stores/runtime-observations.js';
import type { SessionStore } from '../../db/stores/sessions.js';
import type { ConversationStore } from '../../db/stores/conversations.js';
import type { EventStore } from '../../db/stores/events.js';
import { isDeniedEnvName } from '../../pty/shell-hooks.js';
import type { SessionSwitchEvent } from '../../sessions/service.js';
import type { RuntimeClient } from '../transport/client.js';
import { readRuntimeJson, runtimeDirectory } from '../ownership/storage.js';
import { retireMissingRuntime } from '../ownership/discovery.js';
import { runtimeBindingIdentity } from '../transport/connections.js';
import { RuntimeAttentionStore } from '../../db/stores/runtime-attention.js';
import { HostAdmission } from '../../host/lifecycle/admission.js';

interface ReconcileDeps {
  home: string;
  db: Db;
  runtimes: RuntimeStore;
  sessions: SessionStore;
  conversations: ConversationStore;
  events: EventStore;
  captureEnabled?: (profileId: string) => boolean;
  theme?: () => RuntimeTheme | null;
}
interface Attachment {
  client: RuntimeClient;
  active: Promise<void> | null;
  timer: NodeJS.Timeout | null;
  dirty: boolean;
  failed: boolean;
  retryMs: number;
  disconnected: boolean;
  listen: (event: RuntimeEvent) => void;
}

/** Commit observations, never replay execution. One serial reconciler per owner. */
export class RuntimeReconciler extends EventEmitter {
  readonly observations: RuntimeObservationStore;
  readonly attention: RuntimeAttentionStore;
  private readonly attached = new Map<string, Attachment>();
  private closed = false;
  private paused = false;
  private readonly admission = new HostAdmission();
  private readonly resumableLosses = new Set<string>();

  constructor(private readonly deps: ReconcileDeps) {
    super();
    this.observations = new RuntimeObservationStore(deps.db);
    this.attention = new RuntimeAttentionStore(deps.db);
  }

  async attach(id: string, client: RuntimeClient): Promise<void> {
    const previous = this.attached.get(id);
    if (previous && !previous.disconnected) throw new Error('Runtime is already attached');
    await previous?.active;
    this.admission.assertOpen();
    const entry: Attachment = {
      client,
      active: null,
      timer: null,
      dirty: false,
      failed: false,
      retryMs: 0,
      disconnected: false,
      listen: () => {},
    };
    entry.listen = (event) => {
      if (event.t === 'output') return;
      entry.dirty = true;
      this.schedule(id, entry);
    };
    this.attached.set(id, entry);
    client.on('event', entry.listen);
    client.once('disconnected', () => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      client.off('event', entry.listen);
      entry.disconnected = true;
      entry.failed = true;
    });
    await this.refresh(id);
  }

  refreshProfile(profileId: string): void {
    if (this.closed || this.paused) return;
    for (const [id, entry] of this.attached)
      if (!entry.disconnected && this.deps.runtimes.get(id)?.profile_id === profileId)
        void this.refresh(id);
  }

  refreshThemes(): void {
    for (const [id, entry] of this.attached) {
      entry.dirty = true;
      this.schedule(id, entry);
    }
  }

  pendingIds(): string[] {
    return [...this.attached].filter(([, entry]) => entry.failed).map(([id]) => id);
  }

  settled(id: string): boolean {
    const entry = this.attached.get(id);
    return (
      !this.closed &&
      !this.paused &&
      (!entry || !(entry.active || entry.dirty || entry.failed || entry.disconnected))
    );
  }

  refresh(id: string): Promise<void> {
    const entry = this.attached.get(id);
    if (!entry || this.closed) return Promise.reject(new Error('Runtime is not attached'));
    if (this.paused) return Promise.reject(new Error('Runtime reconciliation is paused'));
    if (entry.active) {
      entry.dirty = true;
      return entry.active;
    }
    entry.dirty = false;
    entry.active = this.admission.run(() =>
      this.reconcile(id, entry.client)
        .then(
          () => {
            if (this.paused) {
              entry.dirty = true;
              return;
            }
            entry.failed = entry.disconnected;
            entry.retryMs = 0;
          },
          () => {
            // Keep the committed cursor, private journal and protected ownership. A
            // storage failure or uncertain response never causes a prompt/launch retry.
            entry.failed = true;
            entry.dirty = true;
            entry.retryMs = Math.min(entry.retryMs ? entry.retryMs * 2 : 1000, 30_000);
          },
        )
        .finally(() => {
          entry.active = null;
          if (entry.dirty) this.schedule(id, entry);
        }),
    );
    return entry.active;
  }

  private schedule(id: string, entry: Attachment): void {
    if (this.closed || this.paused || entry.disconnected || entry.active || entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.refresh(id);
    }, entry.retryMs || 25);
    entry.timer.unref();
  }

  private current(id: string): RuntimeBinding {
    const binding = this.deps.runtimes.get(id);
    if (!binding || !binding.active_segment_id || !['prepared', 'running'].includes(binding.state))
      throw new Error('Runtime has no live segment');
    return binding;
  }

  private segment(binding: RuntimeBinding): RuntimeSegment {
    const segment = this.deps.runtimes.segment(binding.runtime_id, binding.active_segment_id!);
    if (!segment || segment.end_cursor !== null) throw new Error('Runtime has no open segment');
    const conversation =
      binding.conversation_id === null
        ? null
        : this.deps.conversations.get(binding.conversation_id);
    if (binding.conversation_id !== null && !conversation)
      throw new Error('Runtime conversation is missing');
    return {
      id: segment.segment_id,
      start_cursor: segment.start_cursor,
      agent_session_ref: conversation?.agent_session_ref ?? null,
    };
  }

  /** Public to the confirmed-owner-loss path too: no IPC or async work inside the transaction. */
  applyPage(id: string, input: RuntimeEventPage): void {
    this.admission.assertOpen();
    const switches = this.commitPage(id, input);
    this.publish(id, switches);
  }

  private publish(id: string, switches: SessionSwitchEvent[]): void {
    for (const event of switches) this.emit('session-switched', event);
    this.emit('changed', this.deps.runtimes.get(id)!.project_id);
  }

  private commitPage(id: string, input: RuntimeEventPage): SessionSwitchEvent[] {
    const page = runtimeEventPageSchema.parse(input);
    if (page.gap || page.journal.lost_through !== 0)
      throw new Error('Runtime event history is incomplete');
    const switches: SessionSwitchEvent[] = [];
    this.deps.db.transaction(() => {
      let binding = this.current(id);
      if (
        page.journal.acknowledged > Math.max(0, binding.event_cursor) ||
        page.through > page.journal.cursor
      )
        throw new Error('Runtime journal exceeds committed observations');
      let previous = 0;
      for (const event of page.events) {
        if (event.cursor <= previous || event.cursor > page.through)
          throw new Error('Runtime events are out of order');
        previous = event.cursor;
      }
      if (page.through < binding.event_cursor) return;
      let observations = this.observations.get(id);
      if (!observations) {
        if (binding.event_cursor > 0) throw new Error('Runtime observation seed is missing');
        const launch = runtimeLaunchSchema.parse(
          readRuntimeJson(join(runtimeDirectory(this.deps.home, id), 'launch.json')),
        );
        const expected = runtimeBindingIdentity(binding);
        for (const key of Object.keys(expected) as Array<keyof typeof expected>)
          if (launch.identity[key] !== expected[key])
            throw new Error('Runtime observation seed identity changed');
        observations = { captureEnabled: launch.capture_env?.enabled ?? false, terminals: [] };
        this.deps.sessions.clearEnv(binding.active_session_id);
        this.deps.sessions.mergeEnv(
          binding.active_session_id,
          Object.fromEntries(
            Object.entries(launch.capture_env?.values ?? {}).filter(
              ([name]) => !isDeniedEnvName(name),
            ),
          ),
          [],
        );
      }
      let segment = this.segment(binding);
      for (const event of page.events) {
        if (event.cursor <= binding.event_cursor) continue;
        let sessionId = binding.active_session_id;
        let conversationId = binding.conversation_id;
        if (event.t === 'native-lifecycle') {
          const result = this.native(binding, event);
          sessionId = result.sessionId;
          conversationId = result.conversationId;
          segment = event.segment;
        }
        this.deps.runtimes.observe(
          id,
          {
            cursor: event.cursor,
            sessionId,
            conversationId,
            state: 'running',
            segment,
            ...(event.t === 'native-lifecycle' && event.previous_segment_id
              ? { previousSegmentId: event.previous_segment_id }
              : {}),
          },
          () => {
            if (sessionId !== binding.active_session_id) {
              const source = this.deps.sessions.get(binding.active_session_id);
              for (const term of observations.terminals)
                if (term.pid !== null) this.observations.bindTerminal(segment.id, term);
              this.deps.sessions.adoptRuntimeState(source.id, sessionId);
              this.deps.sessions.transferBranchOwnership(source.id, sessionId);
              this.deps.sessions.setStatus(source.id, 'exited');
              this.deps.sessions.setStatus(sessionId, source.status);
              const cause =
                event.t === 'native-lifecycle' &&
                ['resume', 'fork'].includes(event.lifecycle.source)
                  ? (event.lifecycle.source as 'resume' | 'fork')
                  : 'clear';
              this.deps.events.record(source.id, 'native_switched_away', {
                cause,
                target_session: sessionId,
                conversation_id: conversationId,
              });
              this.deps.events.record(sessionId, 'native_switched_to', {
                cause,
                source_session: source.id,
                conversation_id: conversationId,
              });
              switches.push({
                sourceSession: source.id,
                targetSession: sessionId,
                targetProject: source.project_id,
                cause,
                outcome: 'rebound',
              });
            }
            this.applyEvent(this.current(id), observations, event);
          },
        );
        binding = this.current(id);
      }
      // Terminal output/status cursors are disposable; advance through the
      // offered journal boundary only after every retained event was applied.
      if (page.through > binding.event_cursor)
        this.deps.runtimes.observe(
          id,
          {
            cursor: page.through,
            sessionId: binding.active_session_id,
            conversationId: binding.conversation_id,
            state: 'running',
            segment,
          },
          () => {},
        );
      this.observations.save(id, observations);
    })();
    return switches;
  }

  /** Boot policy may resume confirmed losses, never unavailable live owners. */
  autoResumeIds(): string[] {
    return [...this.resumableLosses];
  }

  /** Connection failure is only a reason to inspect the OS claim, never proof of death. */
  async retire(id: string): Promise<boolean> {
    const entry = this.attached.get(id);
    if (entry && !entry.disconnected) return false;
    await entry?.active;
    if (this.closed || this.paused) return false;
    const binding = this.current(id);
    const retired = retireMissingRuntime(
      this.deps.home,
      runtimeBindingIdentity(binding),
      (state, journal) => this.commitFinal(id, state, journal),
    );
    if (retired !== 'retired') return false;
    if (entry?.timer) clearTimeout(entry.timer);
    this.attached.delete(id);
    return true;
  }

  /** Bounded host maintenance may revisit old ended bindings without replaying their effects. */
  retireResultReservations(id: string): boolean {
    if (this.closed) return false;
    const binding = this.deps.runtimes.get(id);
    if (!binding || !['exited', 'failed'].includes(binding.state)) return false;
    if (
      !this.deps.db
        .prepare(
          `SELECT 1 FROM runtime_result_usage u JOIN runtime_result_charges c USING(runtime_id)
      WHERE u.runtime_id = ? AND u.retired = 0
      AND NOT EXISTS (SELECT 1 FROM runtime_turns t WHERE t.runtime_id = c.runtime_id AND t.turn = c.turn) LIMIT 1`,
        )
        .get(id)
    )
      return false;
    retireMissingRuntime(this.deps.home, runtimeBindingIdentity(binding), (state, journal) => {
      this.deps.db.transaction(() => {
        const current = this.deps.runtimes.get(id);
        if (
          !current ||
          !state ||
          !journal ||
          !['exited', 'failed'].includes(current.state) ||
          state.build !== current.build ||
          state.protocol.major !== current.protocol_major ||
          state.protocol.minor !== current.protocol_minor ||
          state.state !== current.state ||
          state.terminals.some((term) => term.pid !== null) ||
          state.journal.persistence_pending ||
          state.journal.cursor !== journal.cursor ||
          journal.lost_through !== 0 ||
          current.event_cursor !== journal.cursor
        )
          return;
        this.observations.retireResults(id);
      })();
    });
    return !!this.deps.db
      .prepare('SELECT 1 FROM runtime_result_usage WHERE runtime_id = ? AND pending_cleanup = 1')
      .get(id);
  }

  private commitFinal(
    id: string,
    state: RuntimeState | null,
    journal: RuntimeJournalRecord | null,
  ): void {
    const switches: SessionSwitchEvent[] = [];
    let interrupted: string | null = null;
    this.deps.db.transaction(() => {
      const original = this.current(id);
      if (
        state &&
        (state.build !== original.build ||
          state.protocol.major !== original.protocol_major ||
          state.protocol.minor !== original.protocol_minor)
      )
        throw new Error('Retained runtime build does not match its launch');
      if (journal) {
        // A recovered journal may contain several wire pages. Commit all final
        // effects and the ended binding together; publish only after that commit.
        for (
          let offset = 0;
          offset < Math.max(1, journal.events.length);
          offset += RUNTIME_LIMITS.eventPage
        ) {
          const events = journal.events.slice(offset, offset + RUNTIME_LIMITS.eventPage);
          const more = offset + events.length < journal.events.length;
          switches.push(
            ...this.commitPage(id, {
              events,
              through: more ? events.at(-1)!.cursor : journal.cursor,
              more,
              gap: journal.lost_through !== 0,
              journal: {
                cursor: journal.cursor,
                acknowledged: journal.acknowledged,
                lost_through: journal.lost_through,
                persistence_pending: false,
              },
            }),
          );
        }
      } else if (original.event_cursor > 0 || state !== null) {
        throw new Error('Retained runtime journal is missing');
      }
      const current = this.current(id);
      const ended =
        state &&
        ['exited', 'failed'].includes(state.state) &&
        state.terminals.every((term) => term.pid === null) &&
        journal &&
        !state.journal.persistence_pending &&
        state.journal.cursor === journal.cursor;
      if (ended) {
        this.applyState(id, state);
        this.deps.runtimes.finish(id, state.state as 'exited' | 'failed', () => {
          this.observations.interruptRunning(current);
          this.deps.sessions.setStatus(current.active_session_id, 'exited');
          if (state.state === 'failed')
            this.deps.events.record(current.active_session_id, 'runtime_failed');
        });
        if (journal.lost_through === 0) this.observations.retireResults(id);
      } else {
        this.deps.runtimes.interrupt(id, () => {
          this.observations.interruptRunning(current);
          this.deps.sessions.setStatus(current.active_session_id, 'interrupted');
          this.deps.events.record(current.active_session_id, 'interrupted', {
            reason: 'runtime_owner_lost',
          });
        });
        interrupted = current.active_session_id;
      }
    })();
    // An absent owner does not prove its provider sidecars/descendants ended.
    // Keep agent recovery explicit until supervisor cleanup provides that proof.
    if (
      interrupted !== null &&
      this.deps.runtimes.get(id)!.agent_type === null &&
      !this.deps.runtimes.stopRequested(id)
    )
      this.resumableLosses.add(interrupted);
    this.publish(id, switches);
  }

  private native(
    binding: RuntimeBinding,
    event: Extract<RuntimeRetainedEvent, { t: 'native-lifecycle' }>,
  ) {
    const source = this.deps.sessions.get(binding.active_session_id);
    const { lifecycle } = event;
    if (source.kind !== 'agent' || !binding.agent_type || binding.account_id === null)
      throw new Error('A terminal runtime cannot bind a native conversation');
    if (lifecycle.event === 'session_end')
      return { sessionId: source.id, conversationId: binding.conversation_id };
    if (event.segment.agent_session_ref !== lifecycle.agent_session_ref)
      throw new Error('Runtime lifecycle and segment identity disagree');
    const conversation = this.deps.conversations.upsert(
      binding.profile_id,
      binding.agent_type,
      binding.account_id,
      {
        ref: lifecycle.agent_session_ref!,
        cwd: lifecycle.cwd,
        ...(lifecycle.native_title !== undefined ? { title: lifecycle.native_title } : {}),
        ...(lifecycle.parent_agent_session_ref !== undefined
          ? { parentRef: lifecycle.parent_agent_session_ref }
          : lifecycle.source === 'fork' && source.agent_session_ref
            ? { parentRef: source.agent_session_ref }
            : {}),
        ...(lifecycle.native_created_at !== undefined
          ? { createdAt: lifecycle.native_created_at }
          : {}),
        ...(lifecycle.native_updated_at !== undefined
          ? { updatedAt: lifecycle.native_updated_at }
          : {}),
      },
    );
    this.deps.conversations.setPreferredAccount(conversation.id, binding.account_id);
    if (event.segment.id === binding.active_segment_id) {
      if (source.conversation_id != null && source.conversation_id !== conversation.id)
        throw new Error('Native conversation changed without a segment boundary');
      this.deps.sessions.setConversation(source.id, conversation.id);
      return { sessionId: source.id, conversationId: conversation.id };
    }
    let sessionId = this.deps.conversations.placement(
      conversation.id,
      binding.project_id,
      binding.canonical_worktree_path,
    );
    if (sessionId === null) {
      sessionId = randomUUID();
      this.deps.sessions.create({
        id: sessionId,
        project_id: source.project_id,
        account_id: binding.account_id,
        conversation_id: conversation.id,
        worktree_path: source.worktree_path,
        base_branch: source.base_branch,
        branch: source.branch,
        separate_branch: source.separate_branch,
        branch_owned: false,
        kind: 'agent',
        agent_type: binding.agent_type,
        agent_mode: source.agent_mode,
        title: null,
        status: 'exited',
        native_sync: source.native_sync ?? 'pending',
        skip_permissions: source.skip_permissions,
      });
    }
    return { sessionId, conversationId: conversation.id };
  }

  private applyEvent(
    binding: RuntimeBinding,
    state: RuntimeObservationState,
    event: RuntimeRetainedEvent,
  ): void {
    const id = binding.active_session_id;
    if ('generation' in event) {
      const term = state.terminals.find((term) => term.term === event.term);
      if (!term || term.generation !== event.generation || term.pid === null)
        throw new Error('Runtime observation has a stale terminal generation');
    }
    switch (event.t) {
      case 'terminal-created': {
        this.observations.bindTerminal(binding.active_segment_id!, event.terminal);
        const previous = state.terminals.find((term) => term.term === event.terminal.term);
        if (previous?.pid != null) throw new Error('Runtime terminal was replaced before exiting');
        state.terminals = state.terminals.filter((term) => term.term !== event.terminal.term);
        state.terminals.push({ ...event.terminal });
        if (event.terminal.term === 'agent')
          this.deps.sessions.setStatus(id, binding.agent_type ? 'starting' : 'running');
        break;
      }
      case 'exit': {
        const terminal = state.terminals.find((term) => term.term === event.term)!;
        terminal.pid = null;
        terminal.exit_code = event.exit_code;
        if (event.term === 'agent') this.deps.sessions.setStatus(id, 'exited');
        this.deps.events.record(id, event.term === 'agent' ? 'exited' : 'runtime_shell_exited', {
          term: event.term,
          exit_code: event.exit_code,
        });
        break;
      }
      case 'env-delta': {
        if (!state.captureEnabled || isDeniedEnvName(event.delta.name))
          throw new Error('Runtime reported an inadmissible environment delta');
        // Coalesced observations were admitted by the owner. Re-applying count
        // admission to their intermediate order can reject a valid final map.
        this.deps.sessions.mergeEnv(
          id,
          event.delta.op === 'set' ? { [event.delta.name]: event.delta.value } : {},
          event.delta.op === 'unset' ? [event.delta.name] : [],
        );
        break;
      }
      case 'cwd': {
        const session = this.deps.sessions.get(id);
        if (session.kind !== 'terminal') break;
        try {
          const directory = realpathSync(event.cwd);
          if (!statSync(directory).isDirectory()) break;
          const path = relative(realpathSync(session.worktree_path), directory);
          this.deps.sessions.setCwd(
            id,
            !path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path) ? null : path,
          );
        } catch {
          /* A removed directory cannot become a valid resume location. */
        }
        break;
      }
      case 'osc-title':
        if (event.segment_id !== binding.active_segment_id)
          throw new Error('Runtime title does not match its observed placement');
        this.deps.sessions.setOscTitle(id, event.title);
        break;
      case 'capture-env':
        state.captureEnabled = event.enabled;
        break;
      case 'clear-env':
        this.deps.sessions.clearEnv(id);
        break;
      case 'turn-started':
        this.observations.saveTurn(binding, event.turn);
        break;
      case 'turn-finished':
        this.observations.saveTurn(binding, event.result);
        break;
      case 'native-lifecycle':
        if (event.lifecycle.event === 'session_end')
          this.deps.events.record(id, 'native_session_end', {
            source: event.lifecycle.source,
            ref: event.lifecycle.agent_session_ref ?? null,
          });
        break;
      case 'native-collision':
        this.deps.events.record(id, 'native_switch_conflict', { ref: event.agent_session_ref });
        break;
    }
  }

  private applyState(id: string, state: RuntimeState): void {
    if (state.state === 'prepared') throw new Error('Runtime launch is still preparing');
    this.deps.db.transaction(() => {
      const binding = this.current(id);
      if (
        state.history.current.id !== binding.active_segment_id ||
        state.journal.cursor > binding.event_cursor
      )
        throw new Error('Runtime changed during state reconciliation');
      const failedBeforeAgent =
        state.state === 'failed' &&
        state.agent === null &&
        state.terminals.length === 0 &&
        state.history.current.agent_session_ref === this.segment(binding).agent_session_ref;
      if (
        !failedBeforeAgent &&
        (state.agent?.provider !== (binding.agent_type ?? undefined) ||
          (state.agent?.agent_session_ref ?? null) !== this.segment(binding).agent_session_ref)
      )
        throw new Error('Runtime provider identity does not match its placement');
      const saved = this.observations.get(id);
      if (
        !saved ||
        saved.captureEnabled !== state.environment.enabled ||
        Object.keys(this.deps.sessions.getEnv(binding.active_session_id)).length !==
          state.environment.count
      )
        throw new Error('Runtime environment observations are incomplete');
      if (
        saved.terminals.length !== state.terminals.length ||
        state.terminals.some((term) => {
          const previous = saved.terminals.find((candidate) => candidate.term === term.term);
          return (
            !previous ||
            previous.generation !== term.generation ||
            previous.pid !== term.pid ||
            previous.exit_code !== term.exit_code
          );
        })
      )
        throw new Error('Runtime terminal observations are incomplete');
      this.observations.save(id, { ...saved, terminals: state.terminals });
      const main = state.terminals.find((term) => term.term === 'agent');
      this.deps.sessions.setStatus(
        binding.active_session_id,
        main?.pid == null ? 'exited' : (state.agent?.status ?? 'running'),
      );
      if (state.agent)
        for (const sessionId of this.deps.runtimes.selectedPlacements(id))
          this.deps.sessions.setNativeSync(sessionId, state.agent.native_sync);
      if (state.attention !== undefined) {
        if (
          state.attention &&
          (state.attention.segment_id !== binding.active_segment_id ||
            (state.attention.reason === 'waiting_input'
              ? main?.pid == null ||
                (binding.agent_type
                  ? state.agent?.status !== 'waiting_input'
                  : !state.terminal_agent)
              : binding.agent_type !== null && main?.pid != null))
        )
          throw new Error('Runtime attention does not match its observed placement');
        this.attention.observe(id, state.event_cursor, binding.active_session_id, state.attention);
      }
    })();
  }

  private async reconcile(id: string, client: RuntimeClient): Promise<void> {
    for (let pass = 0; pass < 32 && !this.closed && !this.paused; pass++) {
      const response = await client.request({
        t: 'events',
        after: Math.max(0, this.current(id).event_cursor),
      });
      if (this.closed || this.paused) return;
      if (response.t !== 'events') throw new Error('Runtime omitted its event page');
      this.applyPage(id, response.page);
      if (response.page.more) continue;
      const inspected = await client.request({ t: 'inspect' });
      if (this.closed || this.paused) return;
      if (inspected.t !== 'state') throw new Error('Runtime omitted its state');
      const state = inspected.state;
      if (state.journal.cursor > this.current(id).event_cursor) continue;
      this.applyState(id, state);
      try {
        await client.request({
          t: 'bind-placement',
          binding: this.deps.runtimes.placementBinding(id),
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'stale_placement') continue;
        throw error;
      }
      if (this.closed || this.paused) return;
      const colours = this.deps.theme?.();
      if (
        colours &&
        state.theme !== undefined &&
        (colours.fg !== state.theme?.fg || colours.bg !== state.theme?.bg)
      ) {
        await client.request({
          t: 'theme',
          placement: this.deps.runtimes.placementBinding(id),
          colours,
        });
        continue; // Inspect again after a replaceable setting change or native switch.
      }
      const desiredCapture = this.deps.captureEnabled?.(this.current(id).profile_id);
      if (desiredCapture !== undefined && state.environment.enabled !== desiredCapture) {
        await client.request({
          t: 'capture-env',
          placement: this.deps.runtimes.placementBinding(id),
          enabled: desiredCapture,
        });
        continue; // Observe the retained setting change before acknowledgement.
      }
      await client.request({ t: 'ack-events', through: this.current(id).event_cursor });
      if (this.closed || this.paused) return;
      this.emit('changed', this.current(id).project_id);
      return;
    }
    if (!this.closed && !this.paused)
      throw new Error('Runtime reconciliation yielded to ongoing observations');
  }

  /** Freeze committed cursors without closing owner connections or stopping execution. */
  pause(): ReturnType<HostAdmission['pause']> {
    const hold = this.admission.pause();
    this.paused = true;
    for (const entry of this.attached.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      entry.dirty = true;
    }
    let released = false;
    return {
      drain: (timeoutMs) => hold.drain(timeoutMs),
      release: () => {
        if (released) return;
        released = true;
        hold.release();
        this.paused = false;
        for (const [id, entry] of this.attached) this.schedule(id, entry);
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.admission.close();
    for (const entry of this.attached.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.client.off('event', entry.listen);
    }
    await this.admission.drain();
    this.attached.clear();
  }
}
