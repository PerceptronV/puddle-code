import type { EditorTab } from '../editor/editor-tabs';
import { basename, dirOf, joinAbsolutePath } from './explorer-paths';

export interface FileTabRevealTarget {
  /** Effective absolute root the receiving ExplorerProvider must represent. */
  directory: string;
  /** Root-relative row to expand, select, and scroll into view. */
  path: string;
  /** A browse rebase required before the reveal can be consumed. */
  browseRoot?: string;
}

/**
 * Translate a path-backed tab into the Files tree location that should reveal
 * it. Worktree files keep their existing root and nested path. External files
 * temporarily rebase Files to the file's containing directory, so the target
 * itself is a root-level row there.
 */
export function fileTabRevealTarget(tab: EditorTab, worktreePath: string): FileTabRevealTarget {
  if (tab.root === undefined) {
    return { directory: worktreePath, path: tab.path };
  }
  const browseRoot = joinAbsolutePath(tab.root, dirOf(tab.path));
  return { directory: browseRoot, path: basename(tab.path), browseRoot };
}
