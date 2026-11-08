import type { LayoutNode, TabRef } from '../../api/workspace/ui-state.js';
import type { DesktopBufferSnapshot, DesktopWorkspaceContent } from './content.js';

const bufferKey = (buffer: Pick<DesktopBufferSnapshot, 'session' | 'path' | 'root'>) =>
  JSON.stringify([buffer.session, buffer.path, buffer.root ?? null]);

/** Drafts without a visible tab still prohibit silently retiring a pane window. */
export function desktopPaneCloseReview(content: DesktopWorkspaceContent) {
  const remaining = new Set(content.buffers.map(bufferKey));
  const targets: Array<{ paneId: string; ref: TabRef }> = [];
  const visit = (node: LayoutNode | null) => {
    if (!node) return;
    if (node.kind === 'split') return node.children.forEach(visit);
    for (const ref of node.tabs) {
      if (ref.type !== 'editor' || ref.tab.kind === 'commit') continue;
      const key = bufferKey(ref.tab);
      if (ref.tab.kind === 'untitled' || remaining.has(key)) targets.push({ paneId: node.id, ref });
      remaining.delete(key);
    }
  };
  if (content.snapshot.layout_mode === 'project') {
    for (const slice of Object.values(content.snapshot.project_layouts)) visit(slice.layout_tree);
  } else visit(content.snapshot.layout_tree);
  return { targets, orphaned: remaining.size, required: targets.length > 0 || remaining.size > 0 };
}
