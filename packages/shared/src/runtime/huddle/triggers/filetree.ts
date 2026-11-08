import { z } from 'zod';
import { huddleKeySchema, huddleRelativePathSchema } from '../../../api/huddle/values.js';

export const HUDDLE_FILETREE_LIMITS = {
  sources: 8,
  directories: 128,
  entries: 8192,
  files: 1024,
  snapshotBytes: 256 * 1024,
  changes: 64,
  scanMs: 10000,
} as const;
export const huddleFiletreePathSchema = huddleRelativePathSchema
  .refine((path) => !path.startsWith('./'))
  .pipe(z.string().max(256));
const glob = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !value.startsWith('/') &&
      !value.split('/').includes('..') &&
      ![...value].some((character) => character.charCodeAt(0) < 32),
    'Expected a relative glob',
  );
export const huddleFiletreeSettingsSchema = z.strictObject({
  worktree: z.string().min(1).max(4096),
  directory: z.union([z.literal('.'), huddleFiletreePathSchema]),
  include: z.array(glob).min(1).max(16),
  exclude: z.array(glob).max(16),
  outputPaths: z.array(huddleFiletreePathSchema).max(32),
  debounceMs: z.number().int().min(50).max(10000),
  reconcileMs: z.number().int().min(1000).max(300000),
});
export type HuddleFiletreeSettings = z.infer<typeof huddleFiletreeSettingsSchema>;
export const huddleFiletreeSnapshotSchema = z
  .array(z.strictObject({ path: huddleFiletreePathSchema, signature: z.string().min(1).max(200) }))
  .max(HUDDLE_FILETREE_LIMITS.files)
  .refine(
    (files) => new Set(files.map((file) => file.path)).size === files.length,
    'Duplicate file path',
  )
  .refine(
    (files) =>
      new TextEncoder().encode(JSON.stringify(files)).length <=
      HUDDLE_FILETREE_LIMITS.snapshotBytes,
    'Filetree snapshot exceeds byte limit',
  );
export type HuddleFiletreeSnapshot = z.infer<typeof huddleFiletreeSnapshotSchema>;
export const huddleFiletreeStateSchema = z.strictObject({
  node: huddleKeySchema,
  generation: z.number().int().nonnegative().safe(),
  activationId: z.uuid(),
  worktree: z.string().min(1).max(4096),
  snapshot: huddleFiletreeSnapshotSchema,
  sequence: z.number().int().nonnegative().safe(),
  pending: z
    .strictObject({
      snapshot: huddleFiletreeSnapshotSchema,
      observedAt: z.iso.datetime(),
      batch: z.number().int().nonnegative().safe(),
    })
    .nullable(),
});
