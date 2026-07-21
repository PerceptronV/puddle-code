import type {
  CreateScratchpadRequest,
  PatchScratchpadRequest,
  ScratchpadEntry,
} from '@puddle/shared';
import { ApiError } from '../../http/errors.js';
import type { Db } from '../db.js';

interface Row {
  id: number;
  profile_id: string;
  scope: string;
  project_id: string | null;
  title: string | null;
  body: string;
  tags: string;
  agent_type: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

function toEntry(r: Row): ScratchpadEntry {
  return {
    ...r,
    scope: r.scope === 'profile' ? 'profile' : 'project',
    tags: JSON.parse(r.tags) as string[],
  };
}

/**
 * The Scratchpad store (SPEC §11): per-profile prompts/notes, each project- or
 * profile-scoped. `position` is a single global REAL per entry (smaller = top),
 * so profile-scoped entries keep a consistent order across projects while
 * project-scoped ones interleave per project. A fresh entry is placed above the
 * current minimum; drag-reorder sends a fractional `position` (client-computed).
 */
export class ScratchpadStore {
  constructor(private readonly db: Db) {}

  /**
   * Entries visible in a given context: profile-scoped ones always, plus the
   * given project's project-scoped ones. Without `projectId`, profile-scoped
   * only. Ordered top-first (ascending position).
   */
  list(profileId: string, projectId?: string): ScratchpadEntry[] {
    const rows = (
      projectId === undefined
        ? this.db
            .prepare(
              `SELECT * FROM scratchpad WHERE profile_id = ? AND scope = 'profile' ORDER BY position ASC`,
            )
            .all(profileId)
        : this.db
            .prepare(
              `SELECT * FROM scratchpad
                 WHERE profile_id = ? AND (scope = 'profile' OR project_id = ?)
                 ORDER BY position ASC`,
            )
            .all(profileId, projectId)
    ) as Row[];
    return rows.map(toEntry);
  }

  get(id: number): ScratchpadEntry {
    const row = this.db.prepare(`SELECT * FROM scratchpad WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw ApiError.notFound('scratchpad', id);
    return toEntry(row);
  }

  create(input: CreateScratchpadRequest): ScratchpadEntry {
    const projectId = resolveScope(input.scope, input.project_id ?? null);
    const now = new Date().toISOString();
    // Place above the current top (smallest position) so a fresh entry leads.
    const min = this.db
      .prepare(`SELECT MIN(position) AS m FROM scratchpad WHERE profile_id = ?`)
      .get(input.profile_id) as { m: number | null };
    const position = (min.m ?? 0) - 1;
    const info = this.db
      .prepare(
        `INSERT INTO scratchpad
           (profile_id, scope, project_id, title, body, tags, agent_type, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.profile_id,
        input.scope,
        projectId,
        input.title ?? null,
        input.body,
        JSON.stringify(input.tags ?? []),
        input.agent_type ?? null,
        position,
        now,
        now,
      );
    return this.get(Number(info.lastInsertRowid));
  }

  update(id: number, patch: PatchScratchpadRequest): ScratchpadEntry {
    const current = this.get(id);
    // Re-pair scope↔project_id whenever either changes, so the invariant holds.
    const scope = patch.scope ?? current.scope;
    const rawProject = patch.project_id !== undefined ? patch.project_id : current.project_id;
    const projectId = resolveScope(scope, rawProject);

    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const set = (col: string, value: string | number | null) => {
      sets.push(`${col} = ?`);
      values.push(value);
    };
    if (patch.scope !== undefined || patch.project_id !== undefined) {
      set('scope', scope);
      set('project_id', projectId);
    }
    if (patch.title !== undefined) set('title', patch.title);
    if (patch.body !== undefined) set('body', patch.body);
    if (patch.tags !== undefined) set('tags', JSON.stringify(patch.tags));
    if (patch.agent_type !== undefined) set('agent_type', patch.agent_type);
    if (patch.position !== undefined) set('position', patch.position);
    if (sets.length === 0) return current;

    set('updated_at', new Date().toISOString());
    values.push(id);
    this.db.prepare(`UPDATE scratchpad SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  delete(id: number): void {
    const info = this.db.prepare(`DELETE FROM scratchpad WHERE id = ?`).run(id);
    if (info.changes === 0) throw ApiError.notFound('scratchpad', id);
  }
}

/** Enforce the scope↔project_id pairing; returns the project_id to persist. */
function resolveScope(scope: string, projectId: string | null): string | null {
  if (scope === 'project') {
    if (!projectId) {
      throw ApiError.badRequest('invalid_scope', 'a project-scoped entry needs a project_id');
    }
    return projectId;
  }
  return null; // profile-scoped entries never carry a project
}
