import { z } from 'zod';
import { profileId } from '../../api/common.js';
import { uiStateSnapshotSchema } from '../../api/workspace/ui-state.js';
import type { DesktopWindowIdentity } from './identity.js';

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
