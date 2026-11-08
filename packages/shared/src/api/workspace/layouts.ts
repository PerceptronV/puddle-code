import { z } from 'zod';
import { isoTimestamp, profileId, projectId, rowId, sessionId } from '../common.js';
import { layoutNodeSchema } from './ui-state.js';
import { windowArrangementSchema } from './window-arrangement.js';

/**
 * Saved layouts (SPEC §11): named snapshots of the centre tiling tree a user
 * can save and load from the top-bar Layouts popover. Each is either
 * **profile**-scoped (captured while the profile-wide layout was live) or
 * **project**-scoped (captured under the client's project-based layout setting,
 * bound to the project it was taken in) — the same hard scope pairing as the
 * Scratchpad. The ordinary payload is one `ProjectLayout`-shaped slice. Native
 * clients may additionally retain a portable window arrangement; the tree stays
 * available as the browser/older-client fallback. Shell chrome and dirty drafts
 * are not part of either named representation.
 */
export const layoutScopeSchema = z.enum(['project', 'profile']);
export type LayoutScope = z.infer<typeof layoutScopeSchema>;

export const savedLayoutSchema = z.object({
  id: rowId,
  profile_id: profileId,
  scope: layoutScopeSchema,
  /** Set iff `scope === 'project'` — the project the layout was saved in. */
  project_id: projectId.nullable(),
  name: z.string(),
  layout_tree: layoutNodeSchema.nullable(),
  active_session: sessionId.nullable(),
  /** Optional native arrangement; the ordinary tree remains a portable browser fallback. */
  window_arrangement: windowArrangementSchema.optional(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});
export type SavedLayout = z.infer<typeof savedLayoutSchema>;

/**
 * POST /api/layouts — a `project`-scoped layout must carry `project_id`; a
 * `profile`-scoped one must omit it (the daemon enforces the pairing and 400s
 * a mismatch, as for the Scratchpad).
 */
export const createLayoutRequestSchema = z.object({
  profile_id: profileId,
  scope: layoutScopeSchema,
  project_id: projectId.optional(),
  name: z.string().min(1).max(200),
  layout_tree: layoutNodeSchema.nullable(),
  active_session: sessionId.nullable().optional(),
  window_arrangement: windowArrangementSchema.optional(),
});
export type CreateLayoutRequest = z.infer<typeof createLayoutRequestSchema>;

/**
 * PATCH /api/layouts/:id — `name` alone is a rename; `layout_tree` (with
 * `active_session`) is "save over" from the popover's Save action. Scope and
 * project are fixed at creation: a layout re-captured under different settings
 * is a new layout, not a mutation.
 */
export const patchLayoutRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    layout_tree: layoutNodeSchema.nullable().optional(),
    active_session: sessionId.nullable().optional(),
    /** Null explicitly replaces a native arrangement with a single-tree layout. */
    window_arrangement: windowArrangementSchema.nullable().optional(),
  })
  .refine((patch) => !patch.window_arrangement || patch.layout_tree !== undefined, {
    message: 'Saving a window arrangement also requires its single-tree fallback',
  });
export type PatchLayoutRequest = z.infer<typeof patchLayoutRequestSchema>;
