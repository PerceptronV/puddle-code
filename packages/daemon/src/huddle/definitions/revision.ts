import { createHash } from 'node:crypto';
import { huddleRevisionContent, type HuddleComponent } from '@puddle/shared';

/** Hash exact source bytes and resolved contracts; canonical key order is independent of discovery. */
export function huddleRevisionDigest(
  files: Record<string, string>,
  components: Record<string, HuddleComponent>,
): string {
  return createHash('sha256').update(huddleRevisionContent(files, components)).digest('hex');
}
