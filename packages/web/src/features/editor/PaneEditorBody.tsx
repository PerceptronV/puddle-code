// Load-bearing: the Monaco bootstrap must import before anything mounts an
// <Editor> (see EditorZone.tsx / monaco-setup.ts). Keep this first.
import './monaco-setup';

import type { RevealTarget } from '../workspace/editor-context';
import { CodeEditor } from './CodeEditor';
import { CommitTabBody } from '../history/CommitTabBody';
import { DiffTabBody } from '../diff/DiffTabBody';
import { FilePreview } from './FilePreview';
import { mediaKind } from './media-kind';
import { MediaViewer } from './MediaViewer';
import { previewKind } from './preview-kind';
import { tabKey, tabKind, type EditorTab } from './editor-tabs';

/**
 * The body of one editor tab (SPEC §8) — a plain file editor (or media viewer),
 * a worktree diff, or a read-only commit file diff. Extracted from the old
 * `EditorZone` so each tiling pane can render its own active editor tab; `reveal`
 * only applies to file tabs. Behind the lazy editor chunk so Monaco stays
 * code-split (its own first import is `./monaco-setup`).
 */
export function PaneEditorBody({ tab, reveal }: { tab: EditorTab; reveal: RevealTarget | null }) {
  const kind = tabKind(tab);
  if (kind === 'diff') {
    return <DiffTabBody key={tabKey(tab)} session={tab.session} path={tab.path} />;
  }
  if (kind === 'commit' && tab.sha) {
    return <CommitTabBody key={tabKey(tab)} session={tab.session} sha={tab.sha} path={tab.path} />;
  }
  const media = mediaKind(tab.path);
  if (media) {
    return <MediaViewer key={tabKey(tab)} session={tab.session} path={tab.path} kind={media} />;
  }
  // The tab-strip toggle flips `view`; a stale `preview` on a path that is no
  // longer previewable (rename) falls back to the source editor.
  const preview = tab.view === 'preview' ? previewKind(tab.path) : null;
  if (preview) {
    return <FilePreview key={tabKey(tab)} session={tab.session} path={tab.path} kind={preview} />;
  }
  return <CodeEditor key={tabKey(tab)} session={tab.session} path={tab.path} reveal={reveal} />;
}
