import { randomBytes } from 'node:crypto';
import type { Project } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';
import type { Db } from '../db.js';

interface Row {
  id: string;
  profile_id: string;
  repo_id: number;
  name: string;
  created_at: string;
  updated_at: string;
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

  list(profileId?: string): Project[] {
    return (
      profileId === undefined
        ? this.db.prepare(`SELECT * FROM projects ORDER BY created_at`).all()
        : this.db
            .prepare(`SELECT * FROM projects WHERE profile_id = ? ORDER BY created_at`)
            .all(profileId)
    ) as Row[];
  }

  get(id: string): Project {
    const row = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw ApiError.notFound('project', id);
    return row;
  }

  touch(id: string): void {
    this.db
      .prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }
}
