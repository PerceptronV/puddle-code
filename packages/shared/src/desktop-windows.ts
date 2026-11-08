import { z } from 'zod';
import { profileId, projectId } from './api/common.js';
import { uiStateSnapshotSchema, tabRefSchema, type TabRef } from './api/workspace/ui-state.js';

/** Private desktop IPC/persistence identity; never selects a host transport. */
export const desktopWindowIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9][a-z0-9_-]*$/)
  .refine((id) => id !== 'constructor' && id !== 'prototype', 'Invalid window identity');

export const desktopWindowIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ id: desktopWindowIdSchema, kind: z.literal('host') }),
  z.object({
    id: desktopWindowIdSchema,
    kind: z.literal('project'),
    profileId,
    projectId,
  }),
  z.object({
    id: desktopWindowIdSchema,
    kind: z.literal('pane'),
    profileId,
    projectId,
  }),
]);
export type DesktopWindowIdentity = z.infer<typeof desktopWindowIdentitySchema>;

/** Only application routes are durable; invitations and query parameters are not. */
export const desktopWindowRouteSchema = z
  .string()
  .max(256)
  .regex(/^\/(?:project\/[0-9a-f]{10}(?:\/session\/[0-9a-f-]{36})?|settings(?:\/[a-z-]+)?)?$/);

/** A recoverable editor draft; host files are never written by a window move. */
export const desktopBufferSnapshotSchema = z.object({
  session: z.string().max(128),
  path: z.string().max(32_768),
  root: z.string().max(32_768).optional(),
  content: z.string().max(8 * 1024 * 1024),
  baseMtimeMs: z.number().finite(),
});
export type DesktopBufferSnapshot = z.infer<typeof desktopBufferSnapshotSchema>;

export const desktopWorkspaceContentSchema = z.object({
  snapshot: uiStateSnapshotSchema,
  buffers: z.array(desktopBufferSnapshotSchema).max(512).default([]),
  /** Opaque renderer view state, bounded with the complete IPC/persistence envelope. */
  views: z.record(z.string().max(1024), z.unknown()).default({}),
});
export type DesktopWorkspaceContent = z.infer<typeof desktopWorkspaceContentSchema>;

export const desktopWorkspaceVersionSchema = z.object({
  revision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  content: desktopWorkspaceContentSchema,
});
export type DesktopWorkspaceVersion = z.infer<typeof desktopWorkspaceVersionSchema>;

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

/** Native geometry is parsed by the shell using its existing placement migration. */
export const desktopWindowStateSchema = z.object({
  version: z.literal(2),
  entries: z.record(
    desktopWindowIdSchema,
    z.object({
      record: z.unknown(),
      open: z.boolean(),
      workspaces: z.record(profileId, desktopWorkspaceVersionSchema),
    }),
  ),
  pending: z.record(desktopWindowIdSchema, desktopWindowTransferSchema),
  outcomes: z.record(
    desktopWindowIdSchema,
    z.object({
      status: z.enum(['committed', 'cancelled']),
      sourceId: desktopWindowIdSchema,
      destinationId: desktopWindowIdSchema,
      profileId: profileId.optional(),
    }),
  ),
});

export const desktopWindowReadSchema = z.object({ profileId });
export const desktopWindowWriteSchema = z.object({
  profileId,
  revision: z.number().int().nonnegative(),
  content: desktopWorkspaceContentSchema,
});
export type DesktopWindowWrite = z.infer<typeof desktopWindowWriteSchema>;

export interface DesktopProfileSeed {
  base: z.infer<typeof uiStateSnapshotSchema>;
  detached: Array<{
    identity: DesktopWindowIdentity;
    snapshot: z.infer<typeof uiStateSnapshotSchema>;
  }>;
}
export type DesktopWindowWriteResult = DesktopWorkspaceVersion & { seed?: DesktopProfileSeed };

export interface DesktopWindowContext {
  identity: DesktopWindowIdentity;
  /** Opaque, shell-selected host association for compatible drag destinations. */
  hostId: string;
  /** A newly opened destination remains read-only until its source commits. */
  stagingTransfer?: string;
}

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
  placement: desktopPanePlacementSchema.optional(),
});
export type DesktopPaneDock = z.infer<typeof desktopPaneDockSchema>;
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
}

export const desktopPaneFocusSchema = z.object({ profileId, ref: tabRefSchema });
export type DesktopPaneFocus = z.infer<typeof desktopPaneFocusSchema>;

/** Window lookup includes a following preview's actual target, not just its slot name. */
export function desktopTabKey(ref: TabRef): string {
  if (ref.type === 'terminal') return JSON.stringify(['terminal', ref.session]);
  const tab = ref.tab;
  return JSON.stringify([
    'editor',
    tab.kind ?? 'file',
    tab.session,
    tab.path,
    tab.root ?? null,
    tab.sha ?? null,
    tab.git_area ?? null,
    tab.view === 'linked' || tab.view === 'locked' ? tab.view : null,
  ]);
}

export const desktopWindowTransferCommandSchema = z.discriminatedUnion('kind', [
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
  desktopWindowTransferCommandSchema.and(z.object({ id: desktopWindowIdSchema })),
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
});
export type DesktopWindowCommandReply = z.infer<typeof desktopWindowCommandReplySchema>;

export interface DesktopWindowLifecycleBridge {
  ready(): Promise<void>;
  onCommand(callback: (command: DesktopWindowCommand) => void): () => void;
  reply(reply: DesktopWindowCommandReply): Promise<void>;
}

/** Capability-detected private bridge, independent of daemon feature availability. */
export interface DesktopWindowsBridge {
  version: 1;
  context(): Promise<DesktopWindowContext>;
  /** Checkpoint this window before a renderer-requested reload. */
  reload?(): Promise<void>;
  read(profileId: string): Promise<DesktopWorkspaceVersion | null>;
  write(request: DesktopWindowWrite): Promise<DesktopWindowWriteResult>;
  lifecycle?: DesktopWindowLifecycleBridge;
  transfers?: DesktopWindowTransfersBridge;
}
