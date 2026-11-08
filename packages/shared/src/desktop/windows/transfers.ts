import { z } from 'zod';
import { profileId, projectId } from '../../api/common.js';
import { tabRefSchema } from '../../api/workspace/ui-state.js';
import {
  desktopWindowIdSchema,
  desktopWindowRouteSchema,
  type DesktopWindowIdentity,
} from './identity.js';
import { desktopWorkspaceContentSchema, type DesktopWorkspaceVersion } from './content.js';
import type {
  DesktopPaneDrag,
  DesktopPaneDrop,
  DesktopTabDrag,
  DesktopTabDrop,
  DesktopProjectDrag,
  DesktopProjectDrop,
} from './drag.js';

export const desktopWindowTransferSchema = z.object({
  id: desktopWindowIdSchema,
  sourceId: desktopWindowIdSchema,
  destinationId: desktopWindowIdSchema,
  profileId,
  sourceRevision: z.number().int().nonnegative(),
  destinationRevision: z.number().int().nonnegative(),
  sourceContent: desktopWorkspaceContentSchema,
  destinationContent: desktopWorkspaceContentSchema,
  closeSource: z.boolean(),
  sourceRoute: desktopWindowRouteSchema.optional(),
  destinationRoute: desktopWindowRouteSchema.optional(),
});
export type DesktopWindowTransfer = z.infer<typeof desktopWindowTransferSchema>;

export const desktopPaneDetachSchema = z.object({
  id: desktopWindowIdSchema,
  profileId,
  projectId,
  revision: z.number().int().nonnegative(),
  source: desktopWorkspaceContentSchema,
  destination: desktopWorkspaceContentSchema,
  sourceRoute: desktopWindowRouteSchema.optional(),
});
export type DesktopPaneDetach = z.infer<typeof desktopPaneDetachSchema>;
export const desktopPanePlacementSchema = z.object({
  paneId: z.string().min(1).max(512),
  edge: z.enum(['left', 'right', 'top', 'bottom']),
});
export const desktopPaneDockSchema = desktopPaneDetachSchema.extend({
  destinationId: desktopWindowIdSchema,
  destinationProjectId: projectId.optional(),
  placement: desktopPanePlacementSchema.optional(),
});
export type DesktopPaneDock = z.infer<typeof desktopPaneDockSchema>;
export const desktopTabPlacementSchema = z.object({
  paneId: z.string().min(1).max(512),
  edge: z.enum(['center', 'left', 'right', 'top', 'bottom']),
  index: z.number().int().nonnegative().max(4096).optional(),
});
export const desktopTabDockSchema = desktopPaneDockSchema.extend({
  placement: desktopTabPlacementSchema,
});
export type DesktopTabDock = z.infer<typeof desktopTabDockSchema>;
export const desktopProjectDockSchema = desktopPaneDetachSchema.extend({
  destinationId: desktopWindowIdSchema,
});
export type DesktopProjectDock = z.infer<typeof desktopProjectDockSchema>;

export const desktopTransferReferenceSchema = z.object({ id: desktopWindowIdSchema, profileId });
export type DesktopTransferReference = z.infer<typeof desktopTransferReferenceSchema>;
export const desktopTransferRetireSchema = desktopTransferReferenceSchema.extend({
  revision: z.number().int().nonnegative(),
});
export type DesktopTransferRetire = z.infer<typeof desktopTransferRetireSchema>;
export interface DesktopDockTarget {
  identity: DesktopWindowIdentity;
  label: string;
}
export interface DesktopTransferObservation {
  status: 'prepared' | 'committed' | 'cancelled' | 'unknown';
  version: DesktopWorkspaceVersion | null;
}
export interface DesktopWindowTransfersBridge {
  /** Resolves once the destination has mounted its staged workspace. */
  preparePane(request: DesktopPaneDetach): Promise<void>;
  /** The source rechecks its capture before committing the accepted destination. */
  commit(request: DesktopTransferReference): Promise<DesktopWorkspaceVersion>;
  cancel(request: DesktopTransferReference): Promise<DesktopTransferObservation>;
  observe(request: DesktopTransferReference): Promise<DesktopTransferObservation>;
  /** Resolves only when the source has confirmed the handoff. */
  accept(request: DesktopTransferReference): Promise<DesktopWorkspaceVersion>;
  focusPane?(request: DesktopPaneFocus): Promise<boolean>;
  dockTargets?(profileId: string): Promise<DesktopDockTarget[]>;
  prepareDock?(request: DesktopPaneDock): Promise<void>;
  retire?(request: DesktopTransferRetire): Promise<void>;
  beginPaneDrag?(request: DesktopPaneDrag): Promise<void>;
  dropPane?(request: DesktopPaneDrop): Promise<void>;
  prepareTabDock?(request: DesktopTabDock): Promise<void>;
  beginTabDrag?(request: DesktopTabDrag): Promise<void>;
  dropTab?(request: DesktopTabDrop): Promise<void>;
  prepareProjectDock?(request: DesktopProjectDock): Promise<void>;
  beginProjectDrag?(request: DesktopProjectDrag): Promise<void>;
  dropProject?(request: DesktopProjectDrop): Promise<void>;
}

export const desktopPaneFocusSchema = z.object({ profileId, ref: tabRefSchema });
export type DesktopPaneFocus = z.infer<typeof desktopPaneFocusSchema>;
