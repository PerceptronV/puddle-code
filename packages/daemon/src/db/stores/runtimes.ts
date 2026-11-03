import { isAbsolute } from 'node:path';
import { runtimeIdentitySchema, type RuntimeIdentity } from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import type { Db } from '../db.js';

export interface RuntimeBinding {
  runtime_id: string;
  incarnation: string;
  launch_id: string;
  launch_fingerprint: string;
  profile_id: string;
  project_id: string;
  launch_session_id: string;
  active_session_id: string;
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

interface Placement {
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

  live(): RuntimeBinding[] {
    return this.db
      .prepare(
        "SELECT * FROM runtime_bindings WHERE state IN ('prepared', 'running') ORDER BY created_at, runtime_id",
      )
      .all() as RuntimeBinding[];
  }

  prepare(input: {
    identity: RuntimeIdentity;
    build: string;
    protocol: { major: number; minor: number };
    releasePath: string;
  }): RuntimeBinding {
    const identity = runtimeIdentitySchema.parse(input.identity);
    if (!isAbsolute(input.releasePath) || input.releasePath.includes('\0'))
      throw new Error('Runtime release path must be absolute');
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
      }),
    );
    return this.db.transaction(() => {
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
      this.db
        .prepare(
          `INSERT INTO runtime_bindings (
        runtime_id, incarnation, launch_id, launch_fingerprint, profile_id, project_id,
        launch_session_id, active_session_id, account_id, agent_type, canonical_worktree_path,
        conversation_id, build, protocol_major, protocol_minor, release_path, state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?)`,
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
          placement.account_id,
          placement.agent_type,
          identity.canonical_worktree_path,
          placement.conversation_id,
          input.build,
          input.protocol.major,
          input.protocol.minor,
          input.releasePath,
          new Date().toISOString(),
        );
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
    },
    apply: (binding: RuntimeBinding) => void,
  ): boolean {
    if (!Number.isSafeInteger(event.cursor) || event.cursor < 0)
      throw new Error('Invalid runtime event cursor');
    return this.db.transaction(() => {
      const current = this.get(id);
      if (!current) throw new Error('Unknown runtime');
      if (event.cursor <= current.event_cursor) return false;
      if (current.state !== 'prepared' && current.state !== 'running')
        throw new Error('An ended runtime cannot be adopted again');
      const placement = this.placement(event.sessionId);
      this.checkPlacement(placement, current);
      if (placement.agent_type !== current.agent_type)
        throw new Error('Runtime provider cannot change during adoption');
      if (event.conversationId !== null) {
        const conversation = this.db
          .prepare('SELECT profile_id, agent_type FROM agent_conversations WHERE id = ?')
          .get(event.conversationId) as { profile_id: string; agent_type: string } | undefined;
        if (
          !conversation ||
          conversation.profile_id !== current.profile_id ||
          conversation.agent_type !== current.agent_type
        )
          throw new Error('Runtime conversation belongs to a different profile or provider');
      }
      // Check uniqueness before applying effects; either both writes commit or neither does.
      this.db
        .prepare(
          `UPDATE runtime_bindings SET active_session_id = ?, conversation_id = ?,
        state = ?, event_cursor = ?, ended_at = ? WHERE runtime_id = ?`,
        )
        .run(
          event.sessionId,
          event.conversationId,
          event.state,
          event.cursor,
          event.state === 'running' ? null : new Date().toISOString(),
          id,
        );
      apply(current);
      return true;
    })();
  }

  /** Call only after owner absence is confirmed, never for IPC timeouts or version mismatches. */
  interrupt(id: string, apply: (binding: RuntimeBinding) => void): boolean {
    return this.db.transaction(() => {
      const current = this.get(id);
      if (!current || (current.state !== 'prepared' && current.state !== 'running')) return false;
      this.db
        .prepare(
          "UPDATE runtime_bindings SET state = 'interrupted', ended_at = ? WHERE runtime_id = ?",
        )
        .run(new Date().toISOString(), id);
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

  private placement(id: string): Placement {
    const placement = this.db
      .prepare(
        `SELECT s.project_id, p.profile_id, s.canonical_worktree_path,
      s.account_id, s.agent_type, s.conversation_id FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?`,
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
