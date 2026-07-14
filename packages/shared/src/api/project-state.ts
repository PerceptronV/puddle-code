import { z } from 'zod';
import { isoTimestamp, sessionId } from './common.js';

/**
 * Per-(project, client) workspace snapshot (SPEC §11 reload semantics).
 * Loose so later phases can extend the shape without a migration; unknown
 * keys round-trip untouched. `editor_tabs` is carried from day one even
 * though the editor itself arrives in Phase 3.
 */
export const uiStateSnapshotSchema = z.looseObject({
  session_tabs: z.array(sessionId).default([]),
  active_session: sessionId.nullable().default(null),
  editor_tabs: z.array(z.object({ session: sessionId, path: z.string() })).default([]),
  layout: z.looseObject({}).default({}),
  explorer_pin: sessionId.nullable().default(null),
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
