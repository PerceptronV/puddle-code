import { z } from 'zod';
import { isoTimestamp, sessionId } from './common.js';

/**
 * An open tab in the centre editor zone. `kind` distinguishes a plain file
 * editor from a worktree diff or a commit-file diff; it is optional so
 * pre-existing snapshots (which only ever stored files) round-trip untouched
 * and read back as files. `sha` is set only for `commit` tabs (the commit the
 * file diff belongs to).
 */
export const editorTabRefSchema = z.object({
  session: sessionId,
  path: z.string(),
  kind: z.enum(['file', 'diff', 'commit']).optional(),
  sha: z.string().optional(),
});
export type EditorTabRef = z.infer<typeof editorTabRefSchema>;

/**
 * A tab in the tiling layout (SPEC §8): either an editor tab (the same
 * `editorTabRefSchema` the flat `editor_tabs` list uses) or a terminal bound to
 * a session. The discriminant `type` keeps the two apart in one array.
 */
export const tabRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('editor'), tab: editorTabRefSchema }),
  z.object({ type: z.literal('terminal'), session: sessionId }),
]);
export type TabRef = z.infer<typeof tabRefSchema>;

/** A leaf pane: an ordered list of tabs and the key of the active one. */
export interface LayoutLeaf {
  kind: 'leaf';
  id: string;
  tabs: TabRef[];
  /** `tabRefKey` of the active tab; null only for an empty leaf. */
  activeKey: string | null;
  /**
   * `tabRefKey` of this pane's single ephemeral "preview" tab (VSCode-style):
   * a single-click open lands here and the NEXT single-click replaces it, until
   * a double-click promotes it to a permanent tab (`previewKey` → null). Optional
   * so pre-existing snapshots round-trip as having no preview tab.
   */
  previewKey?: string | null;
}

/** A split: a row (side-by-side) or column (stacked) of child nodes with relative sizes. */
export interface LayoutSplit {
  kind: 'split';
  id: string;
  direction: 'row' | 'col';
  children: LayoutNode[];
  /** Relative weights, one per child (`sizes.length === children.length`). */
  sizes: number[];
}

/** The recursive tiling tree (SPEC §8): a `LayoutSplit` of nodes, or a `LayoutLeaf`. */
export type LayoutNode = LayoutLeaf | LayoutSplit;

const layoutLeafSchema = z.object({
  kind: z.literal('leaf'),
  id: z.string(),
  tabs: z.array(tabRefSchema).default([]),
  activeKey: z.string().nullable().default(null),
  previewKey: z.string().nullable().default(null),
});

// Recursive schema: the split branch references `layoutNodeSchema` inside a
// `z.lazy` callback (evaluated at parse time, after this const is assigned), so
// there is no initialisation-order hazard.
export const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    layoutLeafSchema,
    z.object({
      kind: z.literal('split'),
      id: z.string(),
      direction: z.enum(['row', 'col']),
      children: z.array(layoutNodeSchema),
      sizes: z.array(z.number()),
    }),
  ]),
);

/**
 * Per-(project, client) workspace snapshot (SPEC §11 reload semantics).
 * Loose so later phases can extend the shape without a migration; unknown
 * keys round-trip untouched. `editor_tabs` is carried from day one even
 * though the editor itself arrives in Phase 3.
 */
export const uiStateSnapshotSchema = z.looseObject({
  session_tabs: z.array(sessionId).default([]),
  active_session: sessionId.nullable().default(null),
  editor_tabs: z.array(editorTabRefSchema).default([]),
  layout: z.looseObject({}).default({}),
  explorer_pin: sessionId.nullable().default(null),
  /** The editor tab focused when the client last had one open. */
  active_editor_tab: editorTabRefSchema.nullable().default(null),
  /** Whether the file explorer panel is expanded. */
  explorer_open: z.boolean().default(true),
  /**
   * Which navigator the left sidebar is showing. `changes` is the unified
   * diff+history view and `search` is content/filename search (SPEC §8); the
   * legacy `diff`/`history` values are still accepted so pre-unification
   * snapshots round-trip (the web maps them onto `changes`).
   */
  sidebar_mode: z
    .enum(['files', 'diff', 'history', 'changes', 'search', 'worktrees'])
    .default('files'),
  /** Whether the left navigator is collapsed to a slim rail. */
  sidebar_collapsed: z.boolean().default(false),
  /** Whether the right sessions sidebar is collapsed to a slim rail. */
  sessions_collapsed: z.boolean().default(false),
  /**
   * User-chosen order of the sessions sidebar (session ids). Sessions not
   * listed here (newly created ones) sort to the top; the list is otherwise
   * drag-reorderable and this persists it (SPEC §8).
   */
  session_order: z.array(sessionId).default([]),
  /**
   * The tiling layout tree (SPEC §8): the source of truth for which tabs are
   * open and where. Null on legacy snapshots — the web rebuilds an equivalent
   * tree from `editor_tabs`/`session_tabs`/`layout` on first load.
   */
  layout_tree: layoutNodeSchema.nullable().default(null),
});
export type UiStateSnapshot = z.infer<typeof uiStateSnapshotSchema>;

export const putProjectStateRequestSchema = z.object({
  ui_state: uiStateSnapshotSchema,
});

export const projectStateResponseSchema = z.object({
  ui_state: uiStateSnapshotSchema,
  updated_at: isoTimestamp,
});
export type ProjectStateResponse = z.infer<typeof projectStateResponseSchema>;
