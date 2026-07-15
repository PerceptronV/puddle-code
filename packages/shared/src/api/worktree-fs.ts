import { z } from 'zod';

/**
 * Worktree file-*mutation* shapes (SPEC §8): create, rename/move, copy, and
 * delete of files and folders. Deliberately separate from the read-only
 * browsing shapes in `worktree-files.ts` and the read-only git inspection in
 * `worktree-git.ts` — these are the only endpoints that change the worktree's
 * on-disk layout from the client. Every `path`/`from`/`to` is validated
 * server-side against the worktree root (see `containedPath`).
 */

/** `POST /api/worktrees/:sid/create` — an empty file or a `mkdir -p` folder. */
export const createEntryRequestSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['file', 'dir']),
});
export type CreateEntryRequest = z.infer<typeof createEntryRequestSchema>;

/** `POST /api/worktrees/:sid/rename` — one `fs.rename`, serving both rename and move. */
export const renameEntryRequestSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});
export type RenameEntryRequest = z.infer<typeof renameEntryRequestSchema>;

/** `POST /api/worktrees/:sid/copy` — recursive copy; `to` is auto-suffixed on collision. */
export const copyEntryRequestSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});
export type CopyEntryRequest = z.infer<typeof copyEntryRequestSchema>;

/** `POST /api/worktrees/:sid/delete` — recursive remove (no host trash). */
export const deleteEntryRequestSchema = z.object({
  path: z.string().min(1),
});
export type DeleteEntryRequest = z.infer<typeof deleteEntryRequestSchema>;

/**
 * Shared response for every mutation: `path` is the resulting worktree-relative
 * path — the created entry, the new name after a rename/move, or (for copy) the
 * final auto-suffixed destination the caller should reveal/select.
 */
export const fsOpResponseSchema = z.object({
  ok: z.literal(true),
  path: z.string(),
});
export type FsOpResponse = z.infer<typeof fsOpResponseSchema>;
