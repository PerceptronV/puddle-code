import type { Project } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';
import type { Db } from '../db.js';

interface Row {
  id: number;
  profile_id: number;
  repo_id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

export class ProjectStore {
  constructor(private readonly db: Db) {}

  create(input: { profile_id: number; repo_id: number; name: string }): Project {
    const now = new Date().toISOString();
    try {
      const info = this.db
        .prepare(
          `INSERT INTO projects (profile_id, repo_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.profile_id, input.repo_id, input.name, now, now);
      return this.get(Number(info.lastInsertRowid));
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

  list(profileId?: number): Project[] {
    return (
      profileId === undefined
        ? this.db.prepare(`SELECT * FROM projects ORDER BY id`).all()
        : this.db.prepare(`SELECT * FROM projects WHERE profile_id = ? ORDER BY id`).all(profileId)
    ) as Row[];
  }

  get(id: number): Project {
    const row = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw ApiError.notFound('project', id);
    return row;
  }

  touch(id: number): void {
    this.db
      .prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }
}
