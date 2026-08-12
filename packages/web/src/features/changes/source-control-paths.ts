import type { GitChangeEntry } from '@puddle/shared';

/**
 * Literal Git paths for one source-control action. A rename is one displayed
 * entry but two pathspecs; keeping both makes a directory action as complete
 * as its per-file counterpart even when the rename crosses that directory.
 */
export function gitEntryPaths(entries: readonly GitChangeEntry[]): string[] {
  const paths = new Set<string>();
  for (const entry of entries) {
    paths.add(entry.path);
    if (entry.old_path !== null) paths.add(entry.old_path);
  }
  return [...paths];
}
