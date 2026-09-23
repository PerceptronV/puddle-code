import { useSyncExternalStore } from 'react';
import { useEditor, type EditorPosition } from '../workspace/editor-context';
import { bufferKey, subscribe } from './buffer-store';
import { ConflictSurface } from './ConflictSurface';
import { useEditorBuffer } from './use-editor-buffer';
import { previewKind, type PreviewKind } from './preview-kind';
import { TextFilePreview } from './TextFilePreview';

/**
 * The rendered view of a previewable file tab (SPEC §8): markdown as inline,
 * theme-styled prose; HTML in a sandboxed iframe (`allow-scripts` without
 * `allow-same-origin`, so the document can never reach the app's origin,
 * token, or storage). The text comes from the tab's shared Monaco model —
 * created from the fetched file on first use — so the preview tracks unsaved
 * edits live. Markdown is sanitised with DOMPurify before it touches
 * innerHTML. Worktree asset references — relative to the document, or
 * absolute from the worktree root — resolve through the authed media endpoint
 * (element loads carry no bearer header): object URLs for inline markdown,
 * data URIs baked into the HTML iframe (a null-origin document cannot load
 * this origin's blob URLs). LaTeX (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) is
 * typeset by KaTeX in BOTH views — for the iframe, before the document is
 * serialised, since that document is on its own once it is. Ctrl/⌘-click on a
 * worktree link in a markdown preview opens that file as an editor tab,
 * previewable files landing straight in their rendered view; the same gesture
 * on non-link content in a following preview reveals its associated source.
 */
export function FilePreview({
  session,
  path,
  kind,
  root,
  focused = true,
  scrollDriver = false,
  scrollReceiver = false,
  scrollChannel = 'profile',
  onRevealSource,
}: {
  session: string;
  path: string;
  kind: PreviewKind;
  /** Absolute browse root of an `external` tab (SPEC §8): the preview reads
      the same rooted buffer the source editor edits, and its asset/link
      resolution stays inside that root. */
  root?: string;
  focused?: boolean;
  scrollDriver?: boolean;
  scrollReceiver?: boolean;
  scrollChannel?: string;
  /** Following previews reveal the associated Monaco source on ctrl/⌘-click. */
  onRevealSource?: (position: EditorPosition) => void;
}) {
  const { openFile } = useEditor();
  const buffer = useEditorBuffer(session, path, null, root, {
    passive: true,
    live: true,
    focused,
  });
  const model = buffer.model;
  const text = useSyncExternalStore(
    (onChange) => subscribe(bufferKey(session, path, root), onChange),
    () => model?.getValue() ?? null,
  );
  // A rendered preview cannot host Monaco's reconciliation surface itself.
  // Keep it as-is while the question is merely offered; after Compare, hand the
  // tab to CodeEditor so loading, retry, and the editable diff are guaranteed.
  if (buffer.conflict && buffer.conflict.phase !== 'unresolved') {
    return <ConflictSurface session={session} path={path} buffer={buffer} focused={focused} />;
  }
  if (text === null) return null; // loading, or a binary masquerading by extension
  return (
    <TextFilePreview
      session={session}
      path={path}
      kind={kind}
      text={text}
      root={root}
      scrollDriver={scrollDriver}
      scrollReceiver={scrollReceiver}
      scrollChannel={scrollChannel}
      focused={focused}
      onRevealSource={onRevealSource}
      onOpenFile={(resolved) =>
        openFile(session, resolved, undefined, {
          ...(previewKind(resolved) ? { view: 'preview' as const } : {}),
          ...(root !== undefined ? { root } : {}),
        })
      }
    />
  );
}
