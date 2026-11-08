import type { SessionCreationCaller } from '../../sessions/creation/caller.js';
import { isAbsolute } from 'node:path';
import {
  runtimeIdentitySchema,
  runtimeSegmentSchema,
  huddleIdSchema,
  huddleRuntimeCapabilitiesSchema,
  supportsHuddleRuntime,
  type HuddleRuntimeCapabilities,
  type RuntimeIdentity,
  type RuntimeSegment,
  type RuntimePlacementBinding,
  type HuddleOwnerState,
  huddleOwnerStateSchema,
  canonicalHuddleJson,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import type { Db } from '../db.js';
import { ProgrammeSpawnStore } from './programme-spawns.js';
import type { ProgrammeOperation } from '../../puddlang/runtime-turn-store.js';

export interface RuntimeBinding {
  /** Absent only in historical fixture inputs; migrated rows always name their role. */
  role?: 'session' | 'huddle';
  huddle_id?: string | null;
  huddle_capabilities?: string | null;
  runtime_id: string;
  incarnation: string;
  launch_id: string;
  launch_fingerprint: string;
  profile_id: string;
  project_id: string;
  launch_session_id: string;
  active_session_id: string;
  active_segment_id: string | null;
  account_id: number | null;
  agent_type: string | null;
  canonical_worktree_path: string;
  conversation_id: number | null;
  build: string;
  protocol_major: number;
  protocol_minor: number;
  release_path: string;
  state: 'prepared' | 'running' | 'exited' | 'failed' | 'interrupted';
  event_cursor: number;
  created_at: string;
  ended_at: string | null;
}

export interface RuntimeSegmentBinding {
  runtime_id: string;
  segment_id: string;
  session_id: string;
  start_cursor: number;
  end_cursor: number | null;
}

interface Placement {
  kind: string;
  huddle_id: string | null;
  project_id: string;
  profile_id: string;
  canonical_worktree_path: string;
  account_id: number | null;
  agent_type: string | null;
  conversation_id: number | null;
}

/** Only puddled writes these bindings; runtime owners never open the application DB. */
export class RuntimeStore {
  constructor(private readonly db: Db) {}

  get(id: string): RuntimeBinding | null {
    return (
      (this.db.prepare('SELECT * FROM runtime_bindings WHERE runtime_id = ?').get(id) as
        RuntimeBinding | undefined) ?? null
    );
  }

  /** Stable bounded catalogue of recorded bindings, never evidence of owner liveness. */
  huddleHistory(
    sessionId: string,
    after?: { created_at: string; runtime_id: string },
  ): RuntimeBinding[] {
    return this.db
      .prepare(
        `SELECT * FROM runtime_bindings WHERE role = 'huddle'
      AND launch_session_id = ? AND active_session_id = ?
      AND (? IS NULL OR created_at < ? OR (created_at = ? AND runtime_id < ?))
      ORDER BY created_at DESC, runtime_id DESC LIMIT 64`,
      )
      .all(
        sessionId,
        sessionId,
        after?.created_at ?? null,
        after?.created_at ?? null,
        after?.created_at ?? null,
        after?.runtime_id ?? null,
      ) as RuntimeBinding[];
  }

  live(limit = Number.MAX_SAFE_INTEGER): RuntimeBinding[] {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error('Invalid runtime inventory limit');
    return this.db
      .prepare(
        "SELECT * FROM runtime_bindings WHERE state IN ('prepared', 'running') ORDER BY created_at, runtime_id LIMIT ?",
      )
      .all(limit) as RuntimeBinding[];
  }

  /** Retained bindings still pin their build until descendant/asset retirement is proven. */
  releaseReferences(
    after = '',
    limit = 128,
  ): Array<Pick<RuntimeBinding, 'runtime_id' | 'release_path'>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new Error('Invalid runtime reference page limit');
    return this.db
      .prepare(
        `SELECT runtime_id, release_path FROM runtime_bindings
      WHERE runtime_id > ? ORDER BY runtime_id LIMIT ?`,
      )
      .all(after, limit) as Array<Pick<RuntimeBinding, 'runtime_id' | 'release_path'>>;
  }

  unstartedProgrammeSessions(): Set<string> {
    return new Set(
      (
        this.db
          .prepare(
            `SELECT s.session_id FROM puddlang_runtime_spawns s WHERE s.runtime_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM terminal_placements p WHERE p.session_id = s.session_id)`,
          )
          .all() as Array<{ session_id: string }>
      ).map((row) => row.session_id),
    );
  }

  unstartedHuddleSessions(): Set<string> {
    return new Set(
      (
        this.db
          .prepare(
            `SELECT s.session_id FROM huddle_runtime_spawns s
      WHERE s.runtime_id IS NULL AND NOT EXISTS
      (SELECT 1 FROM terminal_placements p WHERE p.session_id = s.session_id)`,
          )
          .all() as Array<{ session_id: string }>
      ).map((row) => row.session_id),
    );
  }

  /** Protect exact placement/conversation ownership independently of saved session status. */
  ownerOf(sessionId: string): RuntimeBinding | null {
    return (
      (this.db
        .prepare(
          `
      SELECT r.* FROM runtime_bindings r JOIN sessions s ON s.id = ?
      WHERE r.state IN ('prepared', 'running') AND (
        r.active_session_id = s.id OR
        (s.conversation_id IS NOT NULL AND r.conversation_id = s.conversation_id)
      ) LIMIT 1
    `,
        )
        .get(sessionId) as RuntimeBinding | undefined) ?? null
    );
  }

  segment(id: string, segmentId: string): RuntimeSegmentBinding | null {
    return (
      (this.db
        .prepare('SELECT * FROM runtime_segments WHERE runtime_id = ? AND segment_id = ?')
        .get(id, segmentId) as RuntimeSegmentBinding | undefined) ?? null
    );
  }

  requestStop(id: string, sessionId: string, segmentId: string): void {
    this.db.transaction(() => {
      const current = this.get(id);
      if (
        !current ||
        !['prepared', 'running'].includes(current.state) ||
        current.active_session_id !== sessionId ||
        current.active_segment_id !== segmentId
      )
        throw new Error('Runtime placement changed before stop admission');
      this.db
        .prepare(
          `INSERT INTO runtime_stop_requests (runtime_id, session_id, segment_id, requested_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(runtime_id) DO UPDATE SET session_id = excluded.session_id,
        segment_id = excluded.segment_id, requested_at = excluded.requested_at`,
        )
        .run(id, sessionId, segmentId, new Date().toISOString());
    })();
  }

  stopRequested(id: string): boolean {
    return !!this.db
      .prepare(
        'SELECT 1 FROM runtime_stop_requests WHERE runtime_id = ? UNION ALL SELECT 1 FROM huddle_stop_requests WHERE runtime_id = ? LIMIT 1',
      )
      .get(id, id);
  }

  /** Returns true only for a newly consumed exact Stop, never after a lost reply. */
  requestHuddleStop(id: string, sessionId: string): boolean {
    return this.db.transaction(() => {
      const current = this.get(id);
      if (
        !current ||
        current.role !== 'huddle' ||
        current.active_session_id !== sessionId ||
        !['prepared', 'running'].includes(current.state)
      )
        throw new Error('Huddle changed before Stop admission');
      return (
        this.db
          .prepare(
            'INSERT OR IGNORE INTO huddle_stop_requests (runtime_id, session_id, requested_at) VALUES (?, ?, ?)',
          )
          .run(id, sessionId, new Date().toISOString()).changes === 1
      );
    })();
  }

  hasUnreleasedWorktree(canonicalPath: string): boolean {
    // An interrupted/failed owner may still have provider descendants. Only a
    // complete clean exit proves these resources can be removed automatically.
    return !!this.db
      .prepare(
        `SELECT 1 FROM runtime_bindings WHERE canonical_worktree_path = ?
      AND state != 'exited' LIMIT 1`,
      )
      .get(canonicalPath);
  }

  hasUnreleasedHuddle(sessionId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM runtime_bindings WHERE role = 'huddle' AND active_session_id = ? AND state != 'exited' LIMIT 1",
      )
      .get(sessionId);
  }

  hasUnreleasedCodeRun(directory: string): boolean {
    // A missing reply or failed owner is not proof that its descendants ended.
    return !!this.db
      .prepare(
        `SELECT 1 FROM runtime_code_runs c JOIN runtime_bindings r USING (runtime_id)
      WHERE c.directory = ? AND r.state != 'exited'`,
      )
      .get(directory);
  }

  useLegacyTerminals(sessionId: string): void {
    if (this.ownerOf(sessionId)) throw new Error('Cannot replace a live external runtime');
    this.setTerminalOwner(sessionId, null);
  }

  private setTerminalOwner(sessionId: string, runtimeId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO terminal_placements (session_id, runtime_id) VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET runtime_id = excluded.runtime_id`,
      )
      .run(sessionId, runtimeId);
  }

  usesExternalTerminals(sessionId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM terminal_placements WHERE session_id = ? AND runtime_id IS NOT NULL')
      .get(sessionId);
  }

  selectedOwner(sessionId: string): RuntimeBinding | null {
    return (
      (this.db
        .prepare(
          `SELECT r.* FROM runtime_bindings r
      JOIN terminal_placements p ON p.runtime_id = r.runtime_id WHERE p.session_id = ?`,
        )
        .get(sessionId) as RuntimeBinding | undefined) ?? null
    );
  }

  selectedPlacements(id: string): string[] {
    return (
      this.db
        .prepare('SELECT session_id FROM terminal_placements WHERE runtime_id = ?')
        .all(id) as Array<{ session_id: string }>
    ).map((row) => row.session_id);
  }

  terminalForPlacement(
    sessionId: string,
    term: string,
  ): (RuntimeSegmentBinding & { generation: string }) | null {
    return (
      (this.db
        .prepare(
          `
      SELECT s.*, t.generation FROM runtime_segments s
      JOIN runtime_bindings r USING (runtime_id)
      JOIN runtime_segment_terminals t USING (segment_id)
      JOIN terminal_placements p ON p.session_id = s.session_id AND p.runtime_id = s.runtime_id
      WHERE s.session_id = ? AND t.term = ?
      ORDER BY r.created_at DESC, s.start_cursor DESC LIMIT 1
    `,
        )
        .get(sessionId, term) as (RuntimeSegmentBinding & { generation: string }) | undefined) ??
      null
    );
  }

  /** Only committed database state can authorise a current owner placement. */
  placementBinding(id: string): RuntimePlacementBinding {
    const current = this.get(id);
    if (
      !current ||
      !current.active_segment_id ||
      (current.state !== 'prepared' && current.state !== 'running')
    )
      throw new Error('Runtime has no live committed segment');
    const segment = this.segment(id, current.active_segment_id);
    if (!segment || segment.end_cursor !== null || segment.session_id !== current.active_session_id)
      throw new Error('Runtime segment binding is inconsistent');
    return {
      segment_id: segment.segment_id,
      session_id: segment.session_id,
      through: Math.max(0, current.event_cursor),
    };
  }

  prepare(input: {
    identity: RuntimeIdentity;
    build: string;
    protocol: { major: number; minor: number };
    releasePath: string;
    codeRunDirectory?: string;
    programme?: ProgrammeOperation;
    creation?: SessionCreationCaller;
    huddle?: { id: string; capabilities: HuddleRuntimeCapabilities };
  }): RuntimeBinding {
    const identity = runtimeIdentitySchema.parse(input.identity);
    if (input.creation && (input.programme || input.huddle || input.codeRunDirectory !== undefined))
      throw new Error('Choose one runtime creation caller');
    if (input.creation && !/^[a-f0-9]{64}$/.test(input.creation.identity))
      throw new Error('Invalid runtime creation identity');
    if (input.huddle) {
      huddleIdSchema.parse(input.huddle.id);
      huddleRuntimeCapabilitiesSchema.parse(input.huddle.capabilities);
      if (
        !supportsHuddleRuntime(input.huddle.capabilities) ||
        input.programme ||
        input.codeRunDirectory !== undefined
      )
        throw new Error('Invalid huddle runtime admission');
    }
    if (!isAbsolute(input.releasePath) || input.releasePath.includes('\0'))
      throw new Error('Runtime release path must be absolute');
    if (
      input.codeRunDirectory !== undefined &&
      (!isAbsolute(input.codeRunDirectory) || input.codeRunDirectory.includes('\0'))
    )
      throw new Error('Runtime code run directory must be absolute');
    if (
      !input.build ||
      input.build.length > 128 ||
      ![input.protocol.major, input.protocol.minor].every((n) => Number.isSafeInteger(n) && n >= 0)
    )
      throw new Error('Invalid runtime build metadata');
    const fingerprint = digest(
      JSON.stringify({
        identity,
        build: input.build,
        protocol: input.protocol,
        releasePath: input.releasePath,
        ...(input.huddle ? { role: 'huddle', huddle: input.huddle } : {}),
        ...(input.programme ? { programme: input.programme } : {}),
        ...(input.creation ? { creation: input.creation.identity } : {}),
        ...(input.codeRunDirectory === undefined
          ? {}
          : { codeRunDirectory: input.codeRunDirectory }),
      }),
    );
    return this.db.transaction(() => {
      input.creation?.check();
      const previous = this.db
        .prepare('SELECT * FROM runtime_bindings WHERE runtime_id = ? OR launch_id = ?')
        .get(identity.runtime_id, identity.launch_id) as RuntimeBinding | undefined;
      if (previous) {
        if (previous.launch_fingerprint !== fingerprint)
          throw new Error('Runtime launch identity was already used with different inputs');
        return previous;
      }
      const placement = this.placement(identity.session_id);
      this.checkPlacement(placement, identity);
      if (
        (placement.kind === 'huddle') !== !!input.huddle ||
        (input.huddle &&
          (placement.huddle_id !== input.huddle.id ||
            placement.account_id !== null ||
            placement.agent_type !== null ||
            placement.conversation_id !== null))
      )
        throw new Error('Runtime role does not match its placement');
      this.db
        .prepare(
          `INSERT INTO runtime_bindings (
        runtime_id, incarnation, launch_id, launch_fingerprint, profile_id, project_id,
        launch_session_id, active_session_id, active_segment_id, account_id, agent_type, canonical_worktree_path,
        conversation_id, build, protocol_major, protocol_minor, release_path, state, created_at,
        role, huddle_id, huddle_capabilities
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?)`,
        )
        .run(
          identity.runtime_id,
          identity.incarnation,
          identity.launch_id,
          fingerprint,
          identity.profile_id,
          identity.project_id,
          identity.session_id,
          identity.session_id,
          input.huddle ? null : identity.runtime_id,
          placement.account_id,
          placement.agent_type,
          identity.canonical_worktree_path,
          placement.conversation_id,
          input.build,
          input.protocol.major,
          input.protocol.minor,
          input.releasePath,
          new Date().toISOString(),
          input.huddle ? 'huddle' : 'session',
          input.huddle?.id ?? null,
          input.huddle ? JSON.stringify(input.huddle.capabilities) : null,
        );
      if (!input.huddle) {
        this.db
          .prepare(
            'INSERT INTO runtime_segments (runtime_id, segment_id, session_id, start_cursor) VALUES (?, ?, ?, 0)',
          )
          .run(identity.runtime_id, identity.runtime_id, identity.session_id);
        this.setTerminalOwner(identity.session_id, identity.runtime_id);
      }
      if (input.programme)
        new ProgrammeSpawnStore(this.db).bind(
          input.programme,
          identity.session_id,
          identity.runtime_id,
        );
      input.creation?.bind(identity);
      if (input.codeRunDirectory !== undefined)
        this.db
          .prepare('INSERT INTO runtime_code_runs (runtime_id, directory) VALUES (?, ?)')
          .run(identity.runtime_id, input.codeRunDirectory);
      return this.get(identity.runtime_id)!;
    })();
  }

  /**
   * Apply a runtime observation and its placement/events in one transaction.
   * Repeated cursors never rerun application effects. The callback is synchronous;
   * runtime acknowledgement happens only after this transaction has committed.
   */
  observe(
    id: string,
    event: {
      cursor: number;
      sessionId: string;
      conversationId: number | null;
      state: 'running' | 'exited' | 'failed';
      segment: RuntimeSegment;
      previousSegmentId?: string;
    },
    apply: (binding: RuntimeBinding) => void,
  ): boolean {
    if (!Number.isSafeInteger(event.cursor) || event.cursor < 0)
      throw new Error('Invalid runtime event cursor');
    const segment = runtimeSegmentSchema.parse(event.segment);
    if (segment.start_cursor > event.cursor)
      throw new Error('Runtime segment starts after its event');
    return this.db.transaction(() => {
      const current = this.get(id);
      if (!current) throw new Error('Unknown runtime');
      if (current.role === 'huddle')
        throw new Error('Huddle observations cannot create terminal segments');
      if (event.cursor <= current.event_cursor) return false;
      if (current.state !== 'prepared' && current.state !== 'running')
        throw new Error('An ended runtime cannot be adopted again');
      const placement = this.placement(event.sessionId);
      this.checkPlacement(placement, current);
      if (placement.agent_type !== current.agent_type)
        throw new Error('Runtime provider cannot change during adoption');
      if (event.conversationId !== null) {
        const conversation = this.db
          .prepare(
            'SELECT profile_id, agent_type, agent_session_ref FROM agent_conversations WHERE id = ?',
          )
          .get(event.conversationId) as
          { profile_id: string; agent_type: string; agent_session_ref: string } | undefined;
        if (
          !conversation ||
          conversation.profile_id !== current.profile_id ||
          conversation.agent_type !== current.agent_type
        )
          throw new Error('Runtime conversation belongs to a different profile or provider');
        if (conversation.agent_session_ref !== segment.agent_session_ref)
          throw new Error('Runtime segment does not identify its bound native conversation');
      }
      const previous = current.active_segment_id
        ? this.segment(id, current.active_segment_id)
        : null;
      // Old experimental rows lack segment evidence. Do not invent a historical
      // binding from the current placement or adopt them through this path.
      if (!previous || previous.end_cursor !== null)
        throw new Error('Runtime has no open segment to reconcile');
      if (previous.segment_id === segment.id) {
        if (
          previous.session_id !== event.sessionId ||
          previous.start_cursor !== segment.start_cursor ||
          (current.conversation_id !== null && current.conversation_id !== event.conversationId) ||
          event.previousSegmentId !== undefined
        )
          throw new Error('Runtime segment placement is immutable');
      } else {
        if (
          event.previousSegmentId !== previous.segment_id ||
          segment.start_cursor <= current.event_cursor ||
          segment.start_cursor <= previous.start_cursor
        )
          throw new Error('Runtime segment predecessor or cursor does not match');
        this.db
          .prepare(
            'UPDATE runtime_segments SET end_cursor = ? WHERE runtime_id = ? AND segment_id = ?',
          )
          .run(segment.start_cursor - 1, id, previous.segment_id);
        this.db
          .prepare(
            'INSERT INTO runtime_segments (runtime_id, segment_id, session_id, start_cursor) VALUES (?, ?, ?, ?)',
          )
          .run(id, segment.id, event.sessionId, segment.start_cursor);
      }
      if (event.state !== 'running') this.closeSegment(id, event.cursor);
      // Check uniqueness before applying effects; either both writes commit or neither does.
      this.db
        .prepare(
          `UPDATE runtime_bindings SET active_session_id = ?, active_segment_id = ?, conversation_id = ?,
        state = ?, event_cursor = ?, ended_at = ? WHERE runtime_id = ?`,
        )
        .run(
          event.sessionId,
          segment.id,
          event.conversationId,
          event.state,
          event.cursor,
          event.state === 'running' ? null : new Date().toISOString(),
          id,
        );
      if (current.active_session_id !== event.sessionId) this.setTerminalOwner(event.sessionId, id);
      apply(current);
      return true;
    })();
  }

  /** Commit a durable graph snapshot without creating a terminal segment or releasing ownership. */
  observeHuddle(
    id: string,
    input: HuddleOwnerState,
    apply: (binding: RuntimeBinding) => void,
  ): boolean {
    const state = huddleOwnerStateSchema.parse(input);
    return this.db.transaction(() => {
      const current = this.get(id);
      if (
        !current ||
        current.role !== 'huddle' ||
        current.active_segment_id !== null ||
        current.active_session_id !== current.launch_session_id ||
        current.account_id !== null ||
        current.agent_type !== null ||
        current.conversation_id !== null ||
        current.runtime_id !== state.identity.runtime_id ||
        current.incarnation !== state.identity.incarnation ||
        current.launch_id !== state.identity.launch_id ||
        current.profile_id !== state.identity.profile_id ||
        current.project_id !== state.identity.project_id ||
        current.active_session_id !== state.identity.session_id ||
        current.canonical_worktree_path !== state.identity.canonical_worktree_path ||
        current.huddle_id !== state.scope.huddleId ||
        current.build !== state.build ||
        !current.huddle_capabilities ||
        canonicalHuddleJson(JSON.parse(current.huddle_capabilities)) !==
          canonicalHuddleJson(state.capabilities) ||
        state.persistencePending
      )
        throw new Error('Huddle observation does not match its durable binding');
      if (!['prepared', 'running'].includes(current.state))
        throw new Error('An ended huddle cannot be adopted');
      if (state.observation < current.event_cursor)
        throw new Error('Huddle observation moved backwards');
      if (state.observation === current.event_cursor) return false;
      this.db
        .prepare(
          "UPDATE runtime_bindings SET state = 'running', event_cursor = ? WHERE runtime_id = ?",
        )
        .run(state.observation, id);
      apply(current);
      return true;
    })();
  }

  /** Call only after owner absence is confirmed, never for IPC timeouts or version mismatches. */
  interrupt(id: string, apply: (binding: RuntimeBinding) => void): boolean {
    return this.db.transaction(() => {
      const current = this.get(id);
      if (!current || (current.state !== 'prepared' && current.state !== 'running')) return false;
      this.closeSegment(id, Math.max(0, current.event_cursor));
      this.db
        .prepare(
          "UPDATE runtime_bindings SET state = 'interrupted', ended_at = ? WHERE runtime_id = ?",
        )
        .run(new Date().toISOString(), id);
      apply(current);
      return true;
    })();
  }

  /** Finalise only under the exclusive owner claim, after retained observations commit. */
  finish(
    id: string,
    state: 'exited' | 'failed',
    apply: (binding: RuntimeBinding) => void,
  ): boolean {
    return this.db.transaction(() => {
      const current = this.get(id);
      if (!current || !['prepared', 'running'].includes(current.state)) return false;
      this.closeSegment(id, Math.max(0, current.event_cursor));
      this.db
        .prepare('UPDATE runtime_bindings SET state = ?, ended_at = ? WHERE runtime_id = ?')
        .run(state, new Date().toISOString(), id);
      apply(current);
      return true;
    })();
  }

  /** Removal/retention may release historical bindings, never live ownership. */
  removeEnded(id: string): boolean {
    return (
      this.db
        .prepare(
          "DELETE FROM runtime_bindings WHERE runtime_id = ? AND state NOT IN ('prepared', 'running')",
        )
        .run(id).changes > 0
    );
  }

  private closeSegment(id: string, cursor: number): void {
    this.db
      .prepare(
        'UPDATE runtime_segments SET end_cursor = MAX(start_cursor, ?) WHERE runtime_id = ? AND end_cursor IS NULL',
      )
      .run(cursor, id);
  }

  private placement(id: string): Placement {
    const placement = this.db
      .prepare(
        `SELECT s.project_id, p.profile_id, s.canonical_worktree_path,
      s.account_id, s.agent_type, s.conversation_id, s.kind, s.huddle_id FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?`,
      )
      .get(id) as Placement | undefined;
    if (!placement) throw new Error('Runtime placement does not exist');
    return placement;
  }

  private checkPlacement(
    placement: Placement,
    identity: Pick<RuntimeIdentity, 'profile_id' | 'project_id' | 'canonical_worktree_path'>,
  ): void {
    if (
      placement.profile_id !== identity.profile_id ||
      placement.project_id !== identity.project_id ||
      placement.canonical_worktree_path !== identity.canonical_worktree_path
    )
      throw new Error('Runtime placement ownership does not match its launch identity');
  }
}
