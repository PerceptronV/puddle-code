// Load-bearing: the Monaco bootstrap must import before anything mounts an
// <Editor> (see EditorZone.tsx / monaco-setup.ts). Keep this first.
import './monaco-setup';

import type { RevealTarget } from '../workspace/editor-context';
import { CodeEditor } from './CodeEditor';
import { CommitTabBody } from '../history/CommitTabBody';
import { DiffTabBody } from '../diff/DiffTabBody';
import { UntitledTabBody } from './UntitledTabBody';
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
  // A linked tab renders like a preview of whatever it currently targets. Its
  // `tabKey` is the constant slot key (retargets rewrite the fields under it),
  // so the RENDER key carries the target identity instead — a retarget must
  // remount the view on the new file, exactly as switching preview tabs does.
  const rendered = tab.view === 'preview' || tab.view === 'linked';
  const paneKey =
    tab.view === 'linked' ? `linked:${tab.session}:${tab.root ?? ''}:${tab.path}` : tabKey(tab);
  if (kind === 'diff') {
    return (
      <DiffTabBody
        key={tabKey(tab)}
        session={tab.session}
        path={tab.path}
        root={tab.root}
        area={tab.git_area}
      />
    );
  }
  if (kind === 'commit' && tab.sha) {
    return (
      <CommitTabBody
        key={tabKey(tab)}
        session={tab.session}
        sha={tab.sha}
        path={tab.path}
        root={tab.root}
      />
    );
  }
  // External tabs (SPEC §8): the SAME editor/viewer pipeline as worktree
  // files, with the browse root threaded through — buffers, drafts, sync,
  // and saves all key and route by (session, path, root).
  if (kind === 'external' && tab.root !== undefined) {
    const externalMedia = mediaKind(tab.path);
    if (externalMedia) {
      return (
        <MediaViewer
          key={tabKey(tab)}
          session={tab.session}
          path={tab.path}
          kind={externalMedia}
          root={tab.root}
        />
      );
    }
    // Rendered views work above the worktree too (decision 2026-08-06): the
    // preview pipeline keys its buffer and routes its asset fetches by the
    // same (session, path, root) the source editor uses.
    const externalPreview = rendered ? previewKind(tab.path) : null;
    if (externalPreview) {
      return (
        <FilePreview
          key={paneKey}
          session={tab.session}
          path={tab.path}
          kind={externalPreview}
          root={tab.root}
        />
      );
    }
    return (
      <CodeEditor
        key={tabKey(tab)}
        session={tab.session}
        path={tab.path}
        reveal={reveal}
        root={tab.root}
      />
    );
  }
  // Untitled drafts are worktree-agnostic (their `session` is the nil uuid):
  // `path` is the draft's name in the profile's untitled store (SPEC §8).
  if (kind === 'untitled') {
    return <UntitledTabBody key={tabKey(tab)} name={tab.path} />;
  }
  const media = mediaKind(tab.path);
  if (media) {
    return <MediaViewer key={tabKey(tab)} session={tab.session} path={tab.path} kind={media} />;
  }
  // The tab-strip toggle flips `view`; a stale `preview` on a path that is no
  // longer previewable (rename) falls back to the source editor.
  const preview = rendered ? previewKind(tab.path) : null;
  if (preview) {
    return <FilePreview key={paneKey} session={tab.session} path={tab.path} kind={preview} />;
  }
  return <CodeEditor key={tabKey(tab)} session={tab.session} path={tab.path} reveal={reveal} />;
}
