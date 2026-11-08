import { z } from 'zod';
import { projectId, sessionId } from '../common.js';
import { layoutNodeSchema } from './ui-state.js';

/** Portable layout structure only. Drafts, native placement and host authority stay local. */
export const windowLayoutSliceSchema = z.strictObject({
  layout_tree: layoutNodeSchema.nullable(),
  active_session: sessionId.nullable(),
});
export type WindowLayoutSlice = z.infer<typeof windowLayoutSliceSchema>;

export const savedWindowLayoutSchema = z
  .strictObject({
    /** A logical slot for repeated loads, never an authorised native window id. */
    key: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[a-z0-9][a-z0-9_-]*$/),
    kind: z.enum(['host', 'project', 'pane']),
    /** Detached anchor, or the host's visible project; null for a host dashboard. */
    project_id: projectId.nullable(),
    layout_mode: z.enum(['profile', 'project']),
    layout_tree: layoutNodeSchema.nullable(),
    active_session: sessionId.nullable(),
    project_layouts: z.record(projectId, windowLayoutSliceSchema),
  })
  .superRefine((window, ctx) => {
    if (
      window.kind !== 'host' &&
      (window.project_id === null ||
        window.layout_mode !== 'profile' ||
        Object.keys(window.project_layouts).length !== 0)
    )
      ctx.addIssue({ code: 'custom', message: 'Detached windows require one anchored workspace' });
    if (Object.keys(window.project_layouts).length > 512)
      ctx.addIssue({ code: 'custom', message: 'Too many project layouts' });
  });
export type SavedWindowLayout = z.infer<typeof savedWindowLayoutSchema>;

export const windowArrangementSchema = z
  .strictObject({
    version: z.literal(1),
    windows: z.array(savedWindowLayoutSchema).min(1).max(64),
  })
  .superRefine((arrangement, ctx) => {
    const keys = new Set<string>();
    const projects = new Set<string>();
    let hosts = 0;
    for (const window of arrangement.windows) {
      if (keys.has(window.key)) ctx.addIssue({ code: 'custom', message: 'Duplicate window slot' });
      keys.add(window.key);
      if (window.kind === 'host') hosts++;
      if (window.kind === 'project') {
        if (projects.has(window.project_id!))
          ctx.addIssue({ code: 'custom', message: 'Duplicate project window' });
        projects.add(window.project_id!);
      }
    }
    if (hosts > 1)
      ctx.addIssue({ code: 'custom', message: 'An arrangement has at most one host window' });
  });
export type WindowArrangement = z.infer<typeof windowArrangementSchema>;

/** Project saves own anchored panes intact, including mixed-project tabs. */
export function windowArrangementScopeError(
  arrangement: WindowArrangement,
  scope: 'project' | 'profile',
  project: string | null,
): string | null {
  if (scope === 'profile') return null;
  if (!project) return 'A project arrangement needs a project';
  for (const window of arrangement.windows) {
    if (window.project_id !== project) return 'Window belongs to another project';
    if (
      window.kind === 'host' &&
      (window.layout_mode !== 'project' ||
        window.layout_tree !== null ||
        window.active_session !== null ||
        Object.keys(window.project_layouts).some((id) => id !== project))
    )
      return 'A project arrangement can only replace its own host slice';
  }
  return null;
}
