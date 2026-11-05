import type { EditorTab } from '../../editor/tabs/editor-tabs';
import { joinAbsolutePath, relativePathWithinAbsoluteRoot } from '../../explorer/explorer-paths';

/** Full path at a pane's edge, relative only to the tree currently represented. */
export function panePathLabel(
  tab: EditorTab,
  directory: string | undefined,
  filetreeRoot: string | null,
): string {
  if (tab.kind === 'untitled' || directory === undefined) return tab.path;
  const absolute = joinAbsolutePath(directory, tab.path);
  return filetreeRoot
    ? (relativePathWithinAbsoluteRoot(filetreeRoot, absolute) ?? absolute)
    : absolute;
}
