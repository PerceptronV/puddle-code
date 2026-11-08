import { z } from 'zod';
import { huddleOpenSchema } from './authoring.js';
import {
  HUDDLE_LIMITS,
  huddleKeySchema,
  huddleRelativePathSchema,
  canonicalHuddleJson,
} from './values.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Private recovery metadata, not source or execution authority. No source text or secrets. */
export const huddleDraftBaselineSchema = huddleOpenSchema.extend({
  format: z.literal(1),
  profile: z.string().regex(/^[a-f0-9]{10}$/),
  scope: z.string().min(1).max(8192),
  digest,
  files: z
    .record(huddleRelativePathSchema, digest)
    .refine(
      (files) =>
        Object.hasOwn(files, 'huddle.json') && Object.keys(files).length <= HUDDLE_LIMITS.files,
    ),
  components: z
    .record(huddleKeySchema, digest)
    .refine((components) => Object.keys(components).length <= HUDDLE_LIMITS.nodes),
});
export type HuddleDraftBaseline = z.infer<typeof huddleDraftBaselineSchema>;

export function sameHuddleDraftBaseline(a?: HuddleDraftBaseline, b?: HuddleDraftBaseline): boolean {
  return canonicalHuddleJson(a ?? null) === canonicalHuddleJson(b ?? null);
}

/** Old/malformed metadata never discards a draft or invents a reviewed revision. */
export function restoreHuddleDraftBaseline(value: unknown): HuddleDraftBaseline | undefined {
  const parsed = huddleDraftBaselineSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
