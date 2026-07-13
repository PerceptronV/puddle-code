import type { Session, SessionStatus } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';
import type { Db } from '../db.js';

interface Row {
  id: string;
  project_id: number;
  account_id: number;
  worktree_path: string;
  base_branch: string;
  branch: string;
  agent_type: string;
  agent_session_ref: string | null;
  title: string | null;
  status: SessionStatus;
  skip_permissions: number;
  created_at: string;
  updated_at: string;
  last_activity_at: string | null;
}

export interface NewSessionRow {
  id: string;
  project_id: number;
  account_id: number;
  worktree_path: string;
  base_branch: string;
  branch: string;
  agent_type: string;
  title: string | null;
  skip_permissions: boolean;
}

function toSession(r: Row): Session {
  return { ...r, skip_permissions: r.skip_permissions === 1 };
}

const ACTIVE = `('starting', 'running', 'waiting_input', 'exited', 'interrupted')`;

export class SessionStore {
  constructor(private readonly db: Db) {}

  create(row: NewSessionRow): Session {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, account_id, worktree_path, base_branch, branch,
           agent_type, title, status, skip_permissions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?)`,
      )
      .run(
        row.id,
        row.project_id,
        row.account_id,
        row.worktree_path,
        row.base_branch,
        row.branch,
        row.agent_type,
        row.title,
        row.skip_permissions ? 1 : 0,
        now,
        now,
      );
    return this.get(row.id);
  }

  get(id: string): Session {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw ApiError.notFound('session', id);
    return toSession(row);
  }

  list(filter: { project_id?: number; status?: SessionStatus } = {}): Session[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.project_id !== undefined) {
      clauses.push('project_id = ?');
      params.push(filter.project_id);
    }
    if (filter.status !== undefined) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY created_at`)
      .all(...params) as Row[];
    return rows.map(toSession);
  }

  listByStatus(statuses: SessionStatus[]): Session[] {
    const marks = statuses.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE status IN (${marks}) ORDER BY created_at`)
      .all(...statuses) as Row[];
    return rows.map(toSession);
  }

  listActiveByRepo(repoId: number): Session[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM sessions s JOIN projects p ON p.id = s.project_id
         WHERE p.repo_id = ? AND s.status IN ${ACTIVE}`,
      )
      .all(repoId) as Row[];
    return rows.map(toSession);
  }

  allIds(): string[] {
    return (this.db.prepare(`SELECT id FROM sessions`).all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
  }

  setStatus(id: string, status: SessionStatus): Session {
    this.db
      .prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, new Date().toISOString(), id);
    return this.get(id);
  }

  setAgentSessionRef(id: string, ref: string): void {
    this.db.prepare(`UPDATE sessions SET agent_session_ref = ? WHERE id = ?`).run(ref, id);
  }

  setTitle(id: string, title: string): void {
    this.db
      .prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, new Date().toISOString(), id);
  }

  setSkipPermissions(id: string, on: boolean): void {
    this.db.prepare(`UPDATE sessions SET skip_permissions = ? WHERE id = ?`).run(on ? 1 : 0, id);
  }

  touchActivity(id: string, iso: string): void {
    this.db.prepare(`UPDATE sessions SET last_activity_at = ? WHERE id = ?`).run(iso, id);
  }
}
