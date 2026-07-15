import { randomBytes } from 'node:crypto';
import type { Project } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';
import type { Db } from '../db.js';

interface Row {
  id: string;
  profile_id: string;
  repo_id: number;
  name: string;
  archived: number;
  created_at: string;
  updated_at: string;
}

function toProject(r: Row): Project {
  return { ...r, archived: r.archived === 1 };
}

export class ProjectStore {
  constructor(private readonly db: Db) {}

  create(input: { profile_id: string; repo_id: number; name: string }): Project {
    const now = new Date().toISOString();
    // 10 hex chars (5 random bytes): short, stable URL handles.
    const id = randomBytes(5).toString('hex');
    try {
      this.db
        .prepare(
          `INSERT INTO projects (id, profile_id, repo_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.profile_id, input.repo_id, input.name, now, now);
      return this.get(id);
    } catch (e) {
      if (e instanceof Error && e.message.includes('UNIQUE')) {
        throw ApiError.conflict(
          'project_exists',
          `project '${input.name}' already exists in this profile`,
        );
      }
      throw e;
    }
  }

  /** All projects (including archived); callers filter by `archived` as needed. */
  list(profileId?: string): Project[] {
    const rows = (
      profileId === undefined
        ? this.db.prepare(`SELECT * FROM projects ORDER BY created_at`).all()
        : this.db
            .prepare(`SELECT * FROM projects WHERE profile_id = ? ORDER BY created_at`)
            .all(profileId)
    ) as Row[];
    return rows.map(toProject);
  }

  get(id: string): Project {
    const row = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw ApiError.notFound('project', id);
    return toProject(row);
  }

  /** Rename; the UNIQUE(profile_id, name) collision surfaces as a 409. */
  rename(id: string, name: string): Project {
    try {
      this.db
        .prepare(`UPDATE projects SET name = ?, updated_at = ? WHERE id = ?`)
        .run(name, new Date().toISOString(), id);
    } catch (e) {
      if (e instanceof Error && e.message.includes('UNIQUE')) {
        throw ApiError.conflict('project_exists', `a project named '${name}' already exists`);
      }
      throw e;
    }
    return this.get(id);
  }

  /** Hide/show a project; reversible, never touches its sessions or data. */
  setArchived(id: string, archived: boolean): Project {
    this.db
      .prepare(`UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?`)
      .run(archived ? 1 : 0, new Date().toISOString(), id);
    return this.get(id);
  }

  touch(id: string): void {
    this.db
      .prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }
}
