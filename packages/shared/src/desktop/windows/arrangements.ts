import { z } from 'zod';
import { profileId, projectId } from '../../api/common.js';
import {
  desktopWindowIdSchema,
  desktopWindowIdentitySchema,
  desktopWindowRouteSchema,
} from './identity.js';
import { desktopWorkspaceContentSchema, desktopWorkspaceVersionSchema } from './content.js';
import { uiStateSnapshotSchema } from '../../api/workspace/ui-state.js';

export const desktopArrangementCaptureRequestSchema = z
  .object({
    profileId,
    scope: z.enum(['profile', 'project']),
    projectId: projectId.optional(),
  })
  .refine(
    (request) =>
      request.scope === 'project' ? !!request.projectId : request.projectId === undefined,
    { message: 'Invalid arrangement scope' },
  );
export type DesktopArrangementCaptureRequest = z.infer<
  typeof desktopArrangementCaptureRequestSchema
>;
export const desktopArrangementCaptureSchema = z.object({
  entries: z
    .array(
      z.object({
        identity: desktopWindowIdentitySchema,
        route: desktopWindowRouteSchema.optional(),
        open: z.boolean(),
        returnedProject: z.boolean(),
        /** Observation at capture time; applying a layout requires a new revisioned plan. */
        revision: z.number().int().nonnegative(),
        snapshot: uiStateSnapshotSchema,
      }),
    )
    .max(128),
});
export type DesktopArrangementCapture = z.infer<typeof desktopArrangementCaptureSchema>;
export interface DesktopWindowLayoutsBridge {
  capture(request: DesktopArrangementCaptureRequest): Promise<DesktopArrangementCapture>;
}

/** Shell-directed participation; a renderer never chooses other windows or commits ownership. */
export const desktopArrangementCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('seal-layout'), arrangementId: desktopWindowIdSchema, profileId }),
  z.object({
    kind: z.literal('stage-layout'),
    arrangementId: desktopWindowIdSchema,
    profileId,
    version: desktopWorkspaceVersionSchema,
    route: desktopWindowRouteSchema,
  }),
  z.object({ kind: z.literal('verify-layout'), arrangementId: desktopWindowIdSchema, profileId }),
  z.object({
    kind: z.literal('finish-layout'),
    arrangementId: desktopWindowIdSchema,
    profileId,
    outcome: z.enum(['committed', 'cancelled']),
  }),
]);
export type DesktopArrangementCommand = z.infer<typeof desktopArrangementCommandSchema>;

/** Private, shell-owned revision plan; native records are parsed by the shell. */
export const desktopArrangementChangeSchema = z.object({
  record: z.unknown(),
  revision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 2),
  content: desktopWorkspaceContentSchema,
  open: z.boolean(),
});
export const desktopArrangementTransactionSchema = z.object({
  id: desktopWindowIdSchema,
  ownerId: desktopWindowIdSchema,
  profileId,
  scope: z.enum(['profile', 'project']),
  projectId: projectId.optional(),
  /** Exact active/returned ownership set before staging any new native windows. */
  activeIds: z.array(desktopWindowIdSchema).max(128),
  changes: z.array(desktopArrangementChangeSchema).min(1).max(128),
});
export type DesktopArrangementTransaction = z.infer<typeof desktopArrangementTransactionSchema>;
export const desktopArrangementOutcomeSchema = z.object({
  status: z.enum(['committed', 'cancelled']),
  ownerId: desktopWindowIdSchema,
  profileId,
});
export type DesktopArrangementOutcome = z.infer<typeof desktopArrangementOutcomeSchema>;
