import { z } from 'zod';
import { profileId, projectId } from '../../api/common.js';
import { tabRefSchema } from '../../api/workspace/ui-state.js';
import { desktopWindowIdSchema } from './identity.js';
import { desktopPanePlacementSchema, desktopTabPlacementSchema } from './transfers.js';

/** Native drag data contains a single-use registration, never document content. */
export const desktopPaneDragSchema = z.object({
  token: desktopWindowIdSchema,
  profileId,
  projectId,
  paneId: z.string().min(1).max(512),
});
export type DesktopPaneDrag = z.infer<typeof desktopPaneDragSchema>;
export const desktopProjectDragSchema = desktopPaneDragSchema.omit({ paneId: true });
export type DesktopProjectDrag = z.infer<typeof desktopProjectDragSchema>;
export const desktopTabDragSchema = desktopPaneDragSchema.omit({ paneId: true }).extend({
  ref: tabRefSchema,
  paneId: z.string().min(1).max(512).optional(),
});
export type DesktopTabDrag = z.infer<typeof desktopTabDragSchema>;
export const desktopPaneDragPayloadSchema = z.object({
  token: desktopWindowIdSchema,
  sourceId: desktopWindowIdSchema,
  hostId: desktopWindowIdSchema,
  profileId,
});
export const desktopTabDragPayloadSchema = desktopPaneDragPayloadSchema.extend({
  ref: tabRefSchema,
  paneId: z.string().min(1).max(512).optional(),
});
export const desktopDragScopeSchema = desktopPaneDragPayloadSchema.omit({ token: true });
export type DesktopTabDragPayload = z.infer<typeof desktopTabDragPayloadSchema>;
export const desktopPaneDropSchema = z.object({
  token: desktopWindowIdSchema,
  sourceId: desktopWindowIdSchema,
  profileId,
  projectId,
  placement: desktopPanePlacementSchema,
});
export type DesktopPaneDrop = z.infer<typeof desktopPaneDropSchema>;
export const desktopProjectDropSchema = desktopPaneDropSchema.omit({
  placement: true,
  projectId: true,
});
export type DesktopProjectDrop = z.infer<typeof desktopProjectDropSchema>;
export const desktopTabDropSchema = desktopPaneDropSchema.extend({
  placement: desktopTabPlacementSchema,
});
export type DesktopTabDrop = z.infer<typeof desktopTabDropSchema>;
export const desktopPaneMoveCommandSchema = z.object({
  kind: z.literal('move-pane'),
  profileId,
  projectId,
  paneId: z.string().min(1).max(512),
  destinationId: desktopWindowIdSchema,
  destinationProjectId: projectId,
  placement: desktopPanePlacementSchema,
});
export type DesktopPaneMoveCommand = z.infer<typeof desktopPaneMoveCommandSchema>;
export const desktopTabMoveCommandSchema = desktopPaneMoveCommandSchema.extend({
  kind: z.literal('move-tab'),
  ref: tabRefSchema,
  paneId: z.string().min(1).max(512).optional(),
  placement: desktopTabPlacementSchema,
});
export type DesktopTabMoveCommand = z.infer<typeof desktopTabMoveCommandSchema>;
export const desktopProjectMoveCommandSchema = z.object({
  kind: z.literal('move-project'),
  profileId,
  projectId,
  destinationId: desktopWindowIdSchema,
});
export type DesktopProjectMoveCommand = z.infer<typeof desktopProjectMoveCommandSchema>;
export type DesktopContentMoveCommand =
  DesktopPaneMoveCommand | DesktopTabMoveCommand | DesktopProjectMoveCommand;
