import { z } from 'zod';
import { profileId, projectId } from '../../api/common.js';
import { tabRefSchema } from '../../api/workspace/ui-state.js';
import { desktopWindowIdSchema, desktopWindowRouteSchema } from './identity.js';
import { desktopWorkspaceContentSchema, desktopWorkspaceVersionSchema } from './content.js';
import { desktopPanePlacementSchema, desktopTabPlacementSchema } from './transfers.js';
import { desktopProjectCommandSchema } from './projects.js';
import {
  desktopArrangementCommandSchema,
  desktopArrangementPlanCommandSchema,
  desktopArrangementPlanSchema,
} from './arrangements.js';
import {
  desktopPaneMoveCommandSchema,
  desktopTabMoveCommandSchema,
  desktopProjectMoveCommandSchema,
} from './drag.js';

export const desktopWindowTransferCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('plan-project'),
    transferId: desktopWindowIdSchema,
    profileId,
    projectId,
    content: desktopWorkspaceContentSchema,
    route: desktopWindowRouteSchema.optional(),
  }),
  z.object({
    kind: z.literal('plan-tab'),
    transferId: desktopWindowIdSchema,
    profileId,
    projectId,
    content: desktopWorkspaceContentSchema,
    placement: desktopTabPlacementSchema,
  }),
  z.object({
    kind: z.literal('plan-pane'),
    transferId: desktopWindowIdSchema,
    profileId,
    projectId,
    content: desktopWorkspaceContentSchema,
    placement: desktopPanePlacementSchema.optional(),
  }),
  z.object({ kind: z.literal('stage-window'), transferId: desktopWindowIdSchema, profileId }),
  z.object({ kind: z.literal('cancel-window'), transferId: desktopWindowIdSchema, profileId }),
]);
export type DesktopWindowTransferCommand = z.infer<typeof desktopWindowTransferCommandSchema>;
export const desktopWindowCommandSchema = z.union([
  desktopArrangementPlanCommandSchema.and(z.object({ id: desktopWindowIdSchema })),
  desktopArrangementCommandSchema.and(z.object({ id: desktopWindowIdSchema })),
  desktopProjectCommandSchema.and(z.object({ id: desktopWindowIdSchema })),
  desktopWindowTransferCommandSchema.and(z.object({ id: desktopWindowIdSchema })),
  desktopPaneMoveCommandSchema.and(z.object({ id: desktopWindowIdSchema })),
  desktopTabMoveCommandSchema.and(z.object({ id: desktopWindowIdSchema })),
  desktopProjectMoveCommandSchema.and(z.object({ id: desktopWindowIdSchema })),
  z.discriminatedUnion('kind', [
    z.object({ id: desktopWindowIdSchema, kind: z.literal('checkpoint') }),
    z.object({ id: desktopWindowIdSchema, kind: z.literal('resume') }),
    z.object({
      id: desktopWindowIdSchema,
      kind: z.literal('activate-tab'),
      profileId,
      ref: tabRefSchema,
    }),
  ]),
]);
export type DesktopWindowCommand = z.infer<typeof desktopWindowCommandSchema>;
export const desktopWindowCommandReplySchema = z.object({
  id: desktopWindowIdSchema,
  error: z.string().max(2048).optional(),
  version: desktopWorkspaceVersionSchema.optional(),
  arrangement: desktopArrangementPlanSchema.optional(),
});
export type DesktopWindowCommandReply = z.infer<typeof desktopWindowCommandReplySchema>;

export interface DesktopWindowLifecycleBridge {
  ready(): Promise<void>;
  onCommand(callback: (command: DesktopWindowCommand) => void): () => void;
  reply(reply: DesktopWindowCommandReply): Promise<void>;
}
