import { z } from 'zod';
import { huddleKeySchema, huddleRelativePathSchema } from '../../../api/huddle/values.js';

export const HUDDLE_GIT_LIMITS = {
  sources: 8,
  refs: 4096,
  matched: 1024,
  snapshotBytes: 256 * 1024,
  changes: 64,
  directories: 128,
  entries: 8192,
  commandMs: 5000,
  scanMs: 15000,
} as const;
const ref = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => ![...value].some((char) => char.charCodeAt(0) <= 32));
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const huddleGitSettingsSchema = z
  .strictObject({
    worktree: z.string().min(1).max(4096),
    repository: z.union([z.literal('.'), huddleRelativePathSchema]),
    refs: z
      .array(
        z
          .string()
          .max(256)
          .regex(/^refs\/(heads|tags|remotes)\//)
          .refine(
            (value) =>
              !value.includes('\\') &&
              !value.split('/').includes('..') &&
              ![...value].some((char) => char.charCodeAt(0) < 32),
          ),
      )
      .max(16),
    head: z.boolean(),
    debounceMs: z.number().int().min(50).max(10000),
    reconcileMs: z.number().int().min(1000).max(300000),
  })
  .refine((value) => value.head || value.refs.length > 0, 'Select refs or HEAD to observe');
export type HuddleGitSettings = z.infer<typeof huddleGitSettingsSchema>;
export const huddleGitRefSchema = z.strictObject({
  ref,
  oid: oid.nullable(),
  target: ref.nullable(),
});
export type HuddleGitRef = z.infer<typeof huddleGitRefSchema>;
export const huddleGitSnapshotSchema = z
  .array(huddleGitRefSchema)
  .max(HUDDLE_GIT_LIMITS.matched + 1)
  .refine((items) => new Set(items.map((item) => item.ref)).size === items.length)
  .refine(
    (items) =>
      new TextEncoder().encode(JSON.stringify(items)).length <= HUDDLE_GIT_LIMITS.snapshotBytes,
  );
export type HuddleGitSnapshot = z.infer<typeof huddleGitSnapshotSchema>;
export const huddleGitStateSchema = z.strictObject({
  node: huddleKeySchema,
  generation: z.number().int().nonnegative().safe(),
  activationId: z.uuid(),
  worktree: z.string().min(1).max(4096),
  repository: z.string().min(1).max(4096),
  commonDirectory: z.string().min(1).max(4096),
  snapshot: huddleGitSnapshotSchema,
  sequence: z.number().int().nonnegative().safe(),
  pending: z
    .strictObject({
      snapshot: huddleGitSnapshotSchema,
      observedAt: z.iso.datetime(),
      batch: z.number().int().nonnegative().safe(),
    })
    .nullable(),
});
