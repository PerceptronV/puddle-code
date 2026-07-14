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
