import { z } from 'zod';

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const HOST_PURGE_RECORD_BYTES = 4 * 1024 * 1024;
export const HOST_PURGE_ANCHORS = [
  'bin',
  'installation',
  'runtime-claims',
  'runtime-controller.json',
  'updates',
] as const;
const root = z
  .object({
    name: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (name) =>
          name !== '.' &&
          name !== '..' &&
          !/[\\/\0]/.test(name) &&
          !HOST_PURGE_ANCHORS.some((anchor) => anchor === name),
      ),
    device: z.number().int().nonnegative(),
    inode: z.number().int().positive(),
    kind: z.enum(['directory', 'file', 'symlink']),
    state: z.enum(['planned', 'detached', 'deleted']),
  })
  .strict();
const worktree = z
  .object({
    path: z.string().min(1).max(4096),
    dirty: z.boolean(),
    local_only: z.boolean(),
  })
  .strict();

/** Private host journal. The permanent installation/claim namespace is never purged. */
export const hostPurgeRecordSchema = z
  .object({
    format: z.literal(1),
    id: z.uuid(),
    boot_id: z.uuid(),
    removal_digest: fingerprint,
    phase: z.enum(['waiting', 'deleting', 'complete']),
    fingerprint: fingerprint.nullable(),
    worktree_fingerprint: fingerprint.nullable(),
    roots: z.array(root).max(512),
    worktrees: z.array(worktree).max(4096),
    attempt_id: z.uuid().nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      new Set(record.roots.map((root) => root.name)).size !== record.roots.length ||
      (record.phase === 'waiting' &&
        (record.attempt_id !== null || record.roots.some((root) => root.state !== 'planned'))) ||
      (record.phase !== 'waiting' &&
        (!record.fingerprint || !record.worktree_fingerprint || !record.attempt_id)) ||
      (record.phase === 'complete' && record.roots.some((root) => root.state !== 'deleted')) ||
      (record.fingerprint === null) !== (record.worktree_fingerprint === null)
    )
      context.addIssue({ code: 'custom', message: 'Inconsistent purge progress evidence' });
  });
export type HostPurgeRecord = z.infer<typeof hostPurgeRecordSchema>;

/** OS/SSH helper replies expose deletion impact, never credentials or executable paths. */
export const hostPurgeReviewSchema = z
  .object({
    id: z.uuid(),
    phase: z.enum(['reboot_required', 'ready', 'deleting', 'complete']),
    fingerprint: fingerprint.nullable(),
    worktrees: z.array(worktree).max(4096),
    attempt_id: z.uuid().nullable(),
  })
  .strict();
export type HostPurgeReview = z.infer<typeof hostPurgeReviewSchema>;

export const hostPurgeApplySchema = z
  .object({
    id: z.uuid(),
    fingerprint,
    attempt_id: z.uuid(),
  })
  .strict();
export type HostPurgeApply = z.infer<typeof hostPurgeApplySchema>;
