import type Database from 'better-sqlite3';
import { realpathSync } from 'node:fs';
import type { Session, SessionStatus } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';
import type { Db } from '../db.js';

interface Row {
  id: string;
  project_id: string;
  account_id: number | null;
  conversation_id: number | null;
  placement_alias_of: string | null;
  worktree_path: string;
  canonical_worktree_path: string;
  base_branch: string;
  branch: string;
  separate_branch: number;
  kind: Session['kind'];
  agent_type: string | null;
  title: string | null;
  osc_title: string | null;
  status: SessionStatus;
  skip_permissions: number;
  created_at: string;
  updated_at: string;
  last_activity_at: string | null;
  session_env: string;
  cwd: string | null;
  branch_owned: number;
  native_sync: Session['native_sync'] | null;
  joined_conversation_id: number | null;
  joined_agent_session_ref: string | null;
  joined_agent_title: string | null;
  joined_parent_conversation_id: number | null;
  joined_conversation_missing: number | null;
}

export interface NewSessionRow {
  id: string;
  project_id: string;
  /** Null for terminal sessions (SPEC §4). */
  account_id: number | null;
  worktree_path: string;
  base_branch: string;
  branch: string;
  separate_branch: boolean;
  kind: Session['kind'];
  /** Null for terminal sessions (SPEC §4). */
  agent_type: string | null;
  title: string | null;
  skip_permissions: boolean;
  /** Worktree-relative start directory for a terminal's shell; null = the root. */
  cwd?: string | null;
  /** Catalogue-created placements start exited rather than spawning. */
  status?: SessionStatus;
  conversation_id?: number | null;
  branch_owned?: boolean;
  native_sync?: NonNullable<Session['native_sync']> | null;
}

function toSession(r: Row): Session {
  // session_env may hold secrets — it must never reach the sessions API (SPEC §4).
  const {
    session_env,
    canonical_worktree_path: _canonicalWorktreePath,
    placement_alias_of: _placementAliasOf,
    conversation_id: _directConversationId,
    branch_owned,
    native_sync,
    joined_conversation_id,
    joined_agent_session_ref,
    joined_agent_title,
    joined_parent_conversation_id,
    joined_conversation_missing,
    ...rest
  } = r;
  return {
    ...rest,
    agent_session_ref: joined_agent_session_ref,
    agent_title: joined_agent_title,
    conversation_id: joined_conversation_id,
    parent_conversation_id: joined_parent_conversation_id,
    ...(joined_conversation_missing === 1 ? { conversation_missing: true } : {}),
    branch_owner: branch_owned === 1,
    ...(native_sync !== null ? { native_sync } : {}),
    skip_permissions: r.skip_permissions === 1,
    separate_branch: r.separate_branch === 1,
  };
}

const SESSION_SELECT = `
  SELECT s.*,
    c.id AS joined_conversation_id,
    c.agent_session_ref AS joined_agent_session_ref,
    c.native_title AS joined_agent_title,
    c.parent_conversation_id AS joined_parent_conversation_id,
    c.missing AS joined_conversation_missing
  FROM sessions s
  LEFT JOIN sessions canonical ON canonical.id = s.placement_alias_of
  LEFT JOIN agent_conversations c ON c.id = COALESCE(s.conversation_id, canonical.conversation_id)
`;

const ACTIVE = `('starting', 'running', 'waiting_input', 'exited', 'interrupted')`;

export class SessionStore {
  constructor(private readonly db: Db) {}

  create(row: NewSessionRow): Session {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, account_id, conversation_id,
           worktree_path, canonical_worktree_path, base_branch, branch,
           separate_branch, branch_owned, kind, agent_type, title, status,
           native_sync, skip_permissions, created_at, updated_at, cwd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.project_id,
        row.account_id,
        row.conversation_id ?? null,
        row.worktree_path,
        this.canonicalPath(row.worktree_path),
        row.base_branch,
        row.branch,
        row.separate_branch ? 1 : 0,
        row.branch_owned ? 1 : 0,
        row.kind,
        row.agent_type,
        row.title,
        row.status ?? 'starting',
        row.native_sync ?? (row.kind === 'agent' ? 'pending' : null),
        row.skip_permissions ? 1 : 0,
        now,
        now,
        row.cwd ?? null,
      );
    return this.get(row.id);
  }

  get(id: string): Session {
    const row = this.db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as Row | undefined;
    if (!row) throw ApiError.notFound('session', id);
    return toSession(row);
  }

  /** Session counts and last activity for an account (SPEC §6 usage). */
  usageForAccount(accountId: number): {
    session_count: number;
    active_session_count: number;
    last_activity_at: string | null;
  } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS session_count,
           SUM(CASE WHEN status IN ('starting','running','waiting_input') THEN 1 ELSE 0 END) AS active_session_count,
           MAX(last_activity_at) AS last_activity_at
         FROM sessions WHERE account_id = ?`,
      )
      .get(accountId) as {
      session_count: number;
      active_session_count: number | null;
      last_activity_at: string | null;
    };
    return {
      session_count: row.session_count,
      active_session_count: row.active_session_count ?? 0,
      last_activity_at: row.last_activity_at,
    };
  }

  /**
   * Branch → session title for every session on the repo's projects (any
   * status). Shared-worktree sessions are excluded: their branch (e.g. main)
   * is not puddle-owned and must not be badged as a session branch in pickers.
   */
  branchesForRepo(repoId: number): Array<{ branch: string; title: string | null }> {
    return this.db
      .prepare(
        `SELECT s.branch, s.title FROM sessions s
         JOIN projects p ON p.id = s.project_id WHERE p.repo_id = ? AND s.separate_branch = 1`,
      )
      .all(repoId) as Array<{ branch: string; title: string | null }>;
  }

  /** Non-archived sessions other than `excludeId` attached to this worktree. */
  countOtherActiveOnWorktree(worktreePath: string, excludeId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions
         WHERE worktree_path = ? AND id != ? AND status != 'archived'`,
      )
      .get(worktreePath, excludeId) as { n: number };
    return row.n;
  }

  list(
    filter: { project_id?: string; profile_id?: string; status?: SessionStatus } = {},
  ): Session[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.project_id !== undefined) {
      clauses.push('project_id = ?');
      params.push(filter.project_id);
    }
    if (filter.profile_id !== undefined) {
      // All of a profile's sessions across its projects — the cross-project sidebar.
      clauses.push('project_id IN (SELECT id FROM projects WHERE profile_id = ?)');
      params.push(filter.profile_id);
    }
    if (filter.status !== undefined) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const qualifiedWhere = where.replace(/\b(project_id|status)\b/g, 's.$1');
    const rows = this.db
      .prepare(`${SESSION_SELECT} ${qualifiedWhere} ORDER BY s.created_at`)
      .all(...params) as Row[];
    return rows.map(toSession);
  }

  listByStatus(statuses: SessionStatus[]): Session[] {
    const marks = statuses.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`${SESSION_SELECT} WHERE s.status IN (${marks}) ORDER BY s.created_at`)
      .all(...statuses) as Row[];
    return rows.map(toSession);
  }

  listActiveByRepo(repoId: number): Session[] {
    const rows = this.db
      .prepare(
        `${SESSION_SELECT} JOIN projects p ON p.id = s.project_id
         WHERE p.repo_id = ? AND s.status IN ${ACTIVE}`,
      )
      .all(repoId) as Row[];
    return rows.map(toSession);
  }

  allWorktreePaths(): string[] {
    return (
      this.db.prepare(`SELECT DISTINCT worktree_path FROM sessions`).all() as Array<{
        worktree_path: string;
      }>
    ).map((r) => r.worktree_path);
  }

  setStatus(id: string, status: SessionStatus): Session {
    this.db
      .prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, new Date().toISOString(), id);
    return this.get(id);
  }

  setAgentSessionRef(id: string, ref: string | null): void {
    if (ref === null) {
      this.db
        .prepare(
          `UPDATE sessions SET conversation_id = NULL, placement_alias_of = NULL WHERE id = ?`,
        )
        .run(id);
      return;
    }
    const owner = this.db
      .prepare(
        `SELECT p.profile_id, s.agent_type, s.account_id, s.worktree_path
         FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?`,
      )
      .get(id) as
      | {
          profile_id: string;
          agent_type: string | null;
          account_id: number | null;
          worktree_path: string;
        }
      | undefined;
    if (!owner?.agent_type) throw ApiError.notFound('session', id);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_conversations (
           profile_id, agent_type, agent_session_ref, native_cwd,
           preferred_account_id, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, agent_type, agent_session_ref) DO UPDATE SET
           native_cwd = excluded.native_cwd,
           preferred_account_id = COALESCE(agent_conversations.preferred_account_id, excluded.preferred_account_id),
           last_seen_at = excluded.last_seen_at,
           missing_scan_count = 0,
           missing = 0`,
      )
      .run(owner.profile_id, owner.agent_type, ref, owner.worktree_path, owner.account_id, now);
    const conversation = this.db
      .prepare(
        `SELECT id FROM agent_conversations
         WHERE profile_id = ? AND agent_type = ? AND agent_session_ref = ?`,
      )
      .get(owner.profile_id, owner.agent_type, ref) as { id: number };
    this.db
      .prepare(
        `UPDATE sessions SET conversation_id = ?, placement_alias_of = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(conversation.id, now, id);
  }

  /** Repoint a session at another account (tier-1 migration, SPEC §5). */
  setAccountId(id: string, accountId: number): void {
    this.db
      .prepare(`UPDATE sessions SET account_id = ?, updated_at = ? WHERE id = ?`)
      .run(accountId, new Date().toISOString(), id);
    this.db
      .prepare(
        `UPDATE agent_conversations SET preferred_account_id = ?
         WHERE id = (SELECT conversation_id FROM sessions WHERE id = ?)`,
      )
      .run(accountId, id);
  }

  setConversation(id: string, conversationId: number): void {
    this.db
      .prepare(
        `UPDATE sessions SET conversation_id = ?, placement_alias_of = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(conversationId, new Date().toISOString(), id);
  }

  setNativeSync(id: string, mode: NonNullable<Session['native_sync']>): void {
    this.db
      .prepare(`UPDATE sessions SET native_sync = ?, updated_at = ? WHERE id = ?`)
      .run(mode, new Date().toISOString(), id);
  }

  /** Runtime state follows an exact native switch; the target's title remains untouched. */
  adoptRuntimeState(sourceId: string, targetId: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET
           account_id = (SELECT account_id FROM sessions WHERE id = ?),
           skip_permissions = (SELECT skip_permissions FROM sessions WHERE id = ?),
           session_env = (SELECT session_env FROM sessions WHERE id = ?),
           native_sync = (SELECT native_sync FROM sessions WHERE id = ?),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(sourceId, sourceId, sourceId, sourceId, new Date().toISOString(), targetId);
  }

  /** Exactly one placement owns worktree/branch-dependent destructive actions. */
  transferBranchOwnership(sourceId: string, targetId: string): void {
    this.db.transaction(() => {
      const owned = this.db
        .prepare(`SELECT branch_owned FROM sessions WHERE id = ?`)
        .get(sourceId) as { branch_owned: number } | undefined;
      if (owned?.branch_owned !== 1) return;
      this.db.prepare(`UPDATE sessions SET branch_owned = 0 WHERE id = ?`).run(sourceId);
      this.db.prepare(`UPDATE sessions SET branch_owned = 1 WHERE id = ?`).run(targetId);
    })();
  }

  livePlacementForConversation(conversationId: number): Session | null {
    const row = this.db
      .prepare(
        `${SESSION_SELECT}
         WHERE s.conversation_id = ? AND s.status IN ('starting', 'running', 'waiting_input')
         ORDER BY s.updated_at DESC LIMIT 1`,
      )
      .get(conversationId) as Row | undefined;
    return row ? toSession(row) : null;
  }

  aliasTarget(id: string): string | null {
    const row = this.db.prepare(`SELECT placement_alias_of FROM sessions WHERE id = ?`).get(id) as
      { placement_alias_of: string | null } | undefined;
    return row?.placement_alias_of ?? null;
  }

  canonicalWorktreePath(id: string): string {
    const row = this.db
      .prepare(`SELECT canonical_worktree_path FROM sessions WHERE id = ?`)
      .get(id) as { canonical_worktree_path: string } | undefined;
    if (!row) throw ApiError.notFound('session', id);
    return row.canonical_worktree_path;
  }

  /** User override; null clears it (display reverts to agent_title, then the id). */
  setTitle(id: string, title: string | null): void {
    this.db
      .prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, new Date().toISOString(), id);
  }

  /** The agent's own session name, maintained by the daemon; null when unknown. */
  setAgentTitle(id: string, title: string | null): void {
    this.db
      .prepare(
        `UPDATE agent_conversations SET native_title = ?, native_updated_at = ?, last_seen_at = ?,
           missing_scan_count = 0, missing = 0
         WHERE id = (
           SELECT COALESCE(s.conversation_id, canonical.conversation_id)
           FROM sessions s LEFT JOIN sessions canonical ON canonical.id = s.placement_alias_of
           WHERE s.id = ?
         )`,
      )
      .run(title, new Date().toISOString(), new Date().toISOString(), id);
  }

  /** The terminal-title "sequence" name from the PTY's OSC escapes (SPEC §4). */
  setOscTitle(id: string, title: string | null): void {
    this.db
      .prepare(`UPDATE sessions SET osc_title = ?, updated_at = ? WHERE id = ?`)
      .run(title, new Date().toISOString(), id);
  }

  /** Last prompt-reported directory, worktree-relative; null means worktree root. */
  setCwd(id: string, cwd: string | null): void {
    this.db
      .prepare(`UPDATE sessions SET cwd = ?, updated_at = ? WHERE id = ?`)
      .run(cwd, new Date().toISOString(), id);
  }

  setSkipPermissions(id: string, on: boolean): void {
    this.db.prepare(`UPDATE sessions SET skip_permissions = ? WHERE id = ?`).run(on ? 1 : 0, id);
  }

  // Cached: unlike its siblings this runs up to once a second per stream with
  // live output, so the per-call prepare() is worth avoiding here.
  private touchStmt: Database.Statement<[string, string]> | undefined;
  touchActivity(id: string, iso: string): void {
    this.touchStmt ??= this.db.prepare(`UPDATE sessions SET last_activity_at = ? WHERE id = ?`);
    this.touchStmt.run(iso, id);
  }

  /** Captured `export`s for re-injection at PTY spawn (SPEC §4); {} when none. */
  getEnv(id: string): Record<string, string> {
    const row = this.db.prepare(`SELECT session_env FROM sessions WHERE id = ?`).get(id) as
      { session_env: string } | undefined;
    if (!row) throw ApiError.notFound('session', id);
    try {
      const parsed: unknown = JSON.parse(row.session_env);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter(([, v]) => typeof v === 'string'),
      ) as Record<string, string>;
    } catch {
      return {}; // A corrupt cell degrades to "nothing captured".
    }
  }

  /**
   * Per-variable merge, arrival order = last write wins across a session's
   * terminals; unsetting a name the map doesn't own is a no-op (no tombstones
   * over daemon-baseline env). Returns the merged map.
   */
  mergeEnv(id: string, set: Record<string, string>, unset: string[]): Record<string, string> {
    const merged = { ...this.getEnv(id), ...set };
    for (const name of unset) delete merged[name];
    this.db
      .prepare(`UPDATE sessions SET session_env = ? WHERE id = ?`)
      .run(JSON.stringify(merged), id);
    return merged;
  }

  /** Drop every captured var (the manual purge, SPEC §4). Returns how many were dropped. */
  clearEnv(id: string): number {
    const count = Object.keys(this.getEnv(id)).length;
    this.db.prepare(`UPDATE sessions SET session_env = '{}' WHERE id = ?`).run(id);
    return count;
  }

  private canonicalPath(path: string): string {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  }
}
