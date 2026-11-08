import { createHash } from 'node:crypto';
import { canonicalHuddleJson, type HuddleComponent, type HuddleJson } from '@puddle/shared';

/** Hash exact source bytes and resolved contracts; canonical key order is independent of discovery. */
export function huddleRevisionDigest(
  files: Record<string, string>,
  components: Record<string, HuddleComponent>,
): string {
  return createHash('sha256')
    .update(
      canonicalHuddleJson({
        format: 1,
        files,
        components: components as unknown as HuddleJson,
      }),
    )
    .digest('hex');
}
