import type { Db } from '../db.js';

export interface AgentConversation {
  id: number;
  profile_id: string;
  agent_type: string;
  agent_session_ref: string;
  native_cwd: string;
  native_title: string | null;
  parent_conversation_id: number | null;
  preferred_account_id: number | null;
  native_created_at: string | null;
  native_updated_at: string | null;
  last_seen_at: string;
  missing_scan_count: number;
  missing: boolean;
}

interface Row extends Omit<AgentConversation, 'missing'> {
  missing: number;
}

export interface NativeConversationMetadata {
  ref: string;
  cwd: string;
  title?: string | null;
  parentRef?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

function toConversation(row: Row): AgentConversation {
  return { ...row, missing: row.missing === 1 };
}

/** Durable native-conversation catalogue, keyed within the owning profile. */
export class ConversationStore {
  constructor(private readonly db: Db) {}

  get(id: number): AgentConversation | undefined {
    const row = this.db.prepare(`SELECT * FROM agent_conversations WHERE id = ?`).get(id) as
      Row | undefined;
    return row ? toConversation(row) : undefined;
  }

  getByRef(profileId: string, agentType: string, ref: string): AgentConversation | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM agent_conversations
         WHERE profile_id = ? AND agent_type = ? AND agent_session_ref = ?`,
      )
      .get(profileId, agentType, ref) as Row | undefined;
    return row ? toConversation(row) : undefined;
  }

  list(
    filter: { profileId?: string; agentType?: string; preferredAccountId?: number } = {},
  ): AgentConversation[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (filter.profileId !== undefined) {
      clauses.push('profile_id = ?');
      args.push(filter.profileId);
    }
    if (filter.agentType !== undefined) {
      clauses.push('agent_type = ?');
      args.push(filter.agentType);
    }
    if (filter.preferredAccountId !== undefined) {
      clauses.push('preferred_account_id = ?');
      args.push(filter.preferredAccountId);
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    return (
      this.db
        .prepare(`SELECT * FROM agent_conversations ${where} ORDER BY id`)
        .all(...args) as Row[]
    ).map(toConversation);
  }

  /**
   * Insert or refresh native metadata. Undefined optional fields mean "the
   * lifecycle channel did not carry this value"; an explicit null is native
   * truth and clears the old value.
   */
  upsert(
    profileId: string,
    agentType: string,
    accountId: number | null,
    metadata: NativeConversationMetadata,
    seenAt = new Date().toISOString(),
  ): AgentConversation {
    const existing = this.getByRef(profileId, agentType, metadata.ref);
    let parentConversationId = existing?.parent_conversation_id ?? null;
    if (metadata.parentRef) {
      const parent = this.getByRef(profileId, agentType, metadata.parentRef);
      if (parent) parentConversationId = parent.id;
      else {
        const info = this.db
          .prepare(
            `INSERT INTO agent_conversations (
               profile_id, agent_type, agent_session_ref, native_cwd,
               preferred_account_id, last_seen_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(profileId, agentType, metadata.parentRef, metadata.cwd, accountId, seenAt);
        parentConversationId = Number(info.lastInsertRowid);
      }
    } else if (metadata.parentRef === null) {
      parentConversationId = null;
    }

    if (!existing) {
      const info = this.db
        .prepare(
          `INSERT INTO agent_conversations (
             profile_id, agent_type, agent_session_ref, native_cwd, native_title,
             parent_conversation_id, preferred_account_id, native_created_at,
             native_updated_at, last_seen_at, missing_scan_count, missing
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
        )
        .run(
          profileId,
          agentType,
          metadata.ref,
          metadata.cwd,
          metadata.title ?? null,
          parentConversationId,
          accountId,
          metadata.createdAt ?? null,
          metadata.updatedAt ?? null,
          seenAt,
        );
      return this.get(Number(info.lastInsertRowid))!;
    }

    this.db
      .prepare(
        `UPDATE agent_conversations SET
           native_cwd = ?,
           native_title = ?,
           parent_conversation_id = ?,
           preferred_account_id = COALESCE(preferred_account_id, ?),
           native_created_at = ?,
           native_updated_at = ?,
           last_seen_at = ?,
           missing_scan_count = 0,
           missing = 0
         WHERE id = ?`,
      )
      .run(
        metadata.cwd,
        metadata.title === undefined ? existing.native_title : metadata.title,
        parentConversationId,
        accountId,
        metadata.createdAt === undefined ? existing.native_created_at : metadata.createdAt,
        metadata.updatedAt === undefined ? existing.native_updated_at : metadata.updatedAt,
        seenAt,
        existing.id,
      );
    return this.get(existing.id)!;
  }

  setTitle(id: number, title: string | null): AgentConversation {
    this.db
      .prepare(
        `UPDATE agent_conversations
         SET native_title = ?, native_updated_at = ?, last_seen_at = ?, missing_scan_count = 0, missing = 0
         WHERE id = ?`,
      )
      .run(title, new Date().toISOString(), new Date().toISOString(), id);
    return this.get(id)!;
  }

  setPreferredAccount(id: number, accountId: number): void {
    this.db
      .prepare(`UPDATE agent_conversations SET preferred_account_id = ? WHERE id = ?`)
      .run(accountId, id);
  }

  /**
   * A successful scan is the only operation allowed to advance missing state.
   * The first miss remains provisional; the second confirms deletion. Seen
   * rows recover immediately. Returns conversation ids whose public missing
   * flag changed.
   */
  completeSuccessfulScan(accountId: number, seenRefs: ReadonlySet<string>): number[] {
    const changed: number[] = [];
    const rows = this.list({ preferredAccountId: accountId });
    const now = new Date().toISOString();
    const seen = this.db.prepare(
      `UPDATE agent_conversations
       SET last_seen_at = ?, missing_scan_count = 0, missing = 0
       WHERE id = ?`,
    );
    const missed = this.db.prepare(
      `UPDATE agent_conversations
       SET missing_scan_count = missing_scan_count + 1,
           missing = CASE WHEN missing_scan_count + 1 >= 2 THEN 1 ELSE missing END
       WHERE id = ?`,
    );
    this.db.transaction(() => {
      for (const row of rows) {
        const before = row.missing;
        if (seenRefs.has(row.agent_session_ref)) seen.run(now, row.id);
        else missed.run(row.id);
        if (this.get(row.id)?.missing !== before) changed.push(row.id);
      }
    })();
    return changed;
  }

  /** Canonical placement for a conversation in one project/worktree. */
  placement(
    conversationId: number,
    projectId: string,
    canonicalWorktreePath: string,
  ): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM sessions
         WHERE conversation_id = ? AND project_id = ? AND canonical_worktree_path = ?`,
      )
      .get(conversationId, projectId, canonicalWorktreePath) as { id: string } | undefined;
    return row?.id ?? null;
  }

  placements(conversationId: number): string[] {
    return (
      this.db
        .prepare(`SELECT id FROM sessions WHERE conversation_id = ? ORDER BY created_at`)
        .all(conversationId) as Array<{ id: string }>
    ).map((row) => row.id);
  }
}
