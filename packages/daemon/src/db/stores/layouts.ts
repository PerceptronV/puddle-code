import {
  layoutNodeSchema,
  windowArrangementSchema,
  windowArrangementScopeError,
  type CreateLayoutRequest,
  type LayoutNode,
  type PatchLayoutRequest,
  type SavedLayout,
  type WindowArrangement,
} from '@puddle/shared';
import { ApiError } from '../../http/errors.js';
import type { Db } from '../db.js';

interface Row {
  id: number;
  profile_id: string;
  scope: string;
  project_id: string | null;
  name: string;
  layout_tree: string | null;
  active_session: string | null;
  window_arrangement: string | null;
  created_at: string;
  updated_at: string;
}

function toLayout(r: Row): SavedLayout {
  const { window_arrangement, ...row } = r;
  const arrangement =
    window_arrangement === null
      ? undefined
      : windowArrangementSchema.parse(JSON.parse(window_arrangement));
  if (
    arrangement &&
    windowArrangementScopeError(
      arrangement,
      r.scope === 'profile' ? 'profile' : 'project',
      r.project_id,
    )
  )
    throw new Error('Saved window arrangement has invalid scope');
  return {
    ...row,
    scope: r.scope === 'profile' ? 'profile' : 'project',
    // Validate on read (the 12.0 discipline): a tree this daemon cannot parse
    // must fail loudly here, not surface as a half-restored workspace.
    layout_tree: r.layout_tree === null ? null : layoutNodeSchema.parse(JSON.parse(r.layout_tree)),
    ...(arrangement ? { window_arrangement: arrangement } : {}),
  };
}

function treeColumn(tree: LayoutNode | null): string | null {
  return tree === null ? null : JSON.stringify(tree);
}

/**
 * The saved-layouts store (SPEC §11): named snapshots of the centre tiling
 * tree, each profile- or project-scoped exactly like scratchpad entries.
 * Ordered by name — the popover list is a stable catalogue, not a recency
 * feed, and there is no manual drag order.
 */
export class LayoutStore {
  constructor(private readonly db: Db) {}

  /**
   * Layouts visible in a given context: profile-scoped ones always, plus the
   * given project's project-scoped ones. Without `projectId`, every layout of
   * the profile (the dashboard has no project to scope by, and hiding rows
   * there would make them undeletable).
   */
  list(profileId: string, projectId?: string): SavedLayout[] {
    const rows = (
      projectId === undefined
        ? this.db
            .prepare(`SELECT * FROM layouts WHERE profile_id = ? ORDER BY name ASC`)
            .all(profileId)
        : this.db
            .prepare(
              `SELECT * FROM layouts
                 WHERE profile_id = ? AND (scope = 'profile' OR project_id = ?)
                 ORDER BY name ASC`,
            )
            .all(profileId, projectId)
    ) as Row[];
    return rows.map(toLayout);
  }

  get(id: number): SavedLayout {
    const row = this.db.prepare(`SELECT * FROM layouts WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw ApiError.notFound('layout', id);
    return toLayout(row);
  }

  create(input: CreateLayoutRequest): SavedLayout {
    const projectId = resolveScope(input.scope, input.project_id ?? null);
    const arrangement = arrangementColumn(input.window_arrangement, input.scope, projectId);
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO layouts
           (profile_id, scope, project_id, name, layout_tree, active_session, window_arrangement, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.profile_id,
        input.scope,
        projectId,
        input.name,
        treeColumn(input.layout_tree),
        input.active_session ?? null,
        arrangement,
        now,
        now,
      );
    return this.get(Number(info.lastInsertRowid));
  }

  update(id: number, patch: PatchLayoutRequest): SavedLayout {
    const current = this.get(id);
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const set = (col: string, value: string | null) => {
      sets.push(`${col} = ?`);
      values.push(value);
    };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.layout_tree !== undefined) set('layout_tree', treeColumn(patch.layout_tree));
    if (patch.active_session !== undefined) set('active_session', patch.active_session);
    if (patch.window_arrangement !== undefined) {
      set(
        'window_arrangement',
        arrangementColumn(patch.window_arrangement, current.scope, current.project_id),
      );
    } else if (patch.layout_tree !== undefined) {
      // An old/browser client explicitly saving a new tree replaces the layout.
      // A rename alone retains its complete native arrangement.
      set('window_arrangement', null);
    }
    if (sets.length === 0) return current;

    set('updated_at', new Date().toISOString());
    values.push(id);
    this.db.prepare(`UPDATE layouts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  delete(id: number): void {
    const info = this.db.prepare(`DELETE FROM layouts WHERE id = ?`).run(id);
    if (info.changes === 0) throw ApiError.notFound('layout', id);
  }
}

function arrangementColumn(
  input: WindowArrangement | null | undefined,
  scope: 'project' | 'profile',
  project: string | null,
): string | null {
  if (!input) return null;
  const arrangement = windowArrangementSchema.parse(input);
  const error = windowArrangementScopeError(arrangement, scope, project);
  if (error) throw ApiError.badRequest('invalid_scope', error);
  const json = JSON.stringify(arrangement);
  if (Buffer.byteLength(json) > 2 * 1024 * 1024)
    throw ApiError.badRequest('invalid_arrangement', 'Window arrangement is too large');
  return json;
}

/** Enforce the scope↔project_id pairing; returns the project_id to persist. */
function resolveScope(scope: string, projectId: string | null): string | null {
  if (scope === 'project') {
    if (!projectId) {
      throw ApiError.badRequest('invalid_scope', 'a project-scoped layout needs a project_id');
    }
    return projectId;
  }
  return null; // profile-scoped layouts never carry a project
}
