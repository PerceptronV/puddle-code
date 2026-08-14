import { useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { useClientSettings } from '../../lib/client-settings';
import { downloadPath } from '../../lib/worktree-queries';
import { ConflictSurface } from './ConflictSurface';
import { THEME_NAME } from './monaco-setup';
import { monaco } from './monaco-setup';
import { bindMonacoPreviewScroll } from './monaco-preview-scroll';
import { useEditorBuffer } from './use-editor-buffer';
import { useDirtyDiff } from './use-dirty-diff';
import type { RevealTarget } from '../workspace/editor-context';

/** Muted centred panel for the states where there is nothing to edit. */
function Fallback({
  message,
  session,
  path,
  root,
  download,
}: {
  message: string;
  session: string;
  path: string;
  root?: string;
  download?: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-ground text-sm text-fg-muted">
      <span>{message}</span>
      {download && (
        <button
          type="button"
          onClick={() =>
            void downloadPath(session, path, root).catch((e: unknown) =>
              toast.error(e instanceof Error ? e.message : 'Download failed'),
            )
          }
          className="flex items-center gap-1.5 text-fg-secondary transition-colors hover:text-fg"
        >
          <Download className="size-4" />
          Download
        </button>
      )}
    </div>
  );
}

/**
 * One editor pane for a (session, path) tab, bound to the shared model from
 * the buffer store (SPEC §8). All of the conflict-safe editing behaviour lives
 * in `useEditorBuffer`; this file is the view — the `<Editor>`, the
 * restored-draft notice, the cross-window badge, and the binary/too-large
 * fallbacks.
 */
export function CodeEditor({
  session,
  path,
  reveal,
  root,
  focused = true,
  scrollDriver = false,
  scrollReceiver = false,
  scrollChannel = 'profile',
}: {
  session: string;
  path: string;
  reveal: RevealTarget | null;
  /** Absolute browse root of an `external` tab (SPEC §8) — buffers, drafts,
   * sync, and saves all key and route through it. */
  root?: string;
  /** Whether this is the workspace's logically focused tab. */
  focused?: boolean;
  scrollDriver?: boolean;
  scrollReceiver?: boolean;
  scrollChannel?: string;
}) {
  const settings = useClientSettings();
  const buffer = useEditorBuffer(session, path, reveal, root, { focused });
  const mountDirtyDiff = useDirtyDiff(session, path, root, buffer.model);
  const fontMono = useMemo(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
      undefined,
    [],
  );
  const [mountedEditor, setMountedEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(
    null,
  );
  const scrollTarget = useMemo(() => ({ session, path, root }), [session, path, root]);
  const comparisonOpen = buffer.conflict !== null && buffer.conflict.phase !== 'unresolved';

  // Roles come from the layout's logical focus, never DOM focus. Rebinding on
  // a focus/target change disposes every Monaco listener and pending frame.
  useEffect(() => {
    if (!mountedEditor || !buffer.model || comparisonOpen) return;
    return bindMonacoPreviewScroll(
      mountedEditor,
      {
        channel: scrollChannel,
        target: scrollTarget,
        driver: scrollDriver,
        receiver: scrollReceiver,
      },
      monaco.editor.ScrollType.Immediate,
    );
  }, [
    mountedEditor,
    buffer.model,
    comparisonOpen,
    scrollChannel,
    scrollTarget,
    scrollDriver,
    scrollReceiver,
  ]);

  // Conflict state outranks the query's ordinary file status: the comparison
  // read itself can discover a deletion or fail, in which case `file.error`
  // must not hide the locked, retryable reconciliation state below.
  if (buffer.conflict && buffer.conflict.phase !== 'unresolved') {
    return <ConflictSurface session={session} path={path} buffer={buffer} focused={focused} />;
  }

  if (buffer.status === 'binary') {
    return (
      <Fallback
        message="Binary file — use Download"
        session={session}
        path={path}
        root={root}
        download
      />
    );
  }
  if (buffer.status === 'too-large') {
    return (
      <Fallback
        message="File too large to edit — use Download"
        session={session}
        path={path}
        root={root}
        download
      />
    );
  }
  if (buffer.status === 'error') {
    return (
      <Fallback
        message={buffer.errorMessage ?? 'Failed to load file'}
        session={session}
        path={path}
        root={root}
      />
    );
  }

  const badgeText =
    buffer.peerBadge === 'saved-elsewhere'
      ? 'Saved in another window'
      : buffer.peerBadge === 'dirty-elsewhere'
        ? 'Also being edited in another window'
        : null;

  return (
    <div className="flex h-full flex-col bg-ground">
      {buffer.restoredNotice && (
        <div className="flex items-center gap-3 bg-elevated px-3 py-1.5 text-xs text-fg-secondary">
          <span>Restored unsaved changes</span>
          <button
            type="button"
            onClick={buffer.discardRestore}
            className="text-fg-muted transition-colors hover:text-fg"
          >
            Discard
          </button>
        </div>
      )}
      {badgeText && <div className="bg-surface px-3 py-1 text-xs text-fg-muted">{badgeText}</div>}
      <div className="min-h-0 flex-1">
        {buffer.model && (
          <Editor
            path={buffer.model.uri.toString()}
            defaultValue={buffer.model.getValue()}
            theme={THEME_NAME}
            keepCurrentModel
            onMount={(editor) => {
              buffer.onMount(editor);
              mountDirtyDiff(editor);
              setMountedEditor(editor);
            }}
            loading={<div className="p-3 text-xs text-fg-muted">…</div>}
            options={{
              automaticLayout: true,
              fontFamily: fontMono,
              fontSize: settings.editorFontSize,
              tabSize: settings.editorTabSize,
              wordWrap: settings.editorWordWrap ? 'on' : 'off',
              minimap: { enabled: false },
              glyphMargin: false,
              lineDecorationsWidth: 10,
              fixedOverflowWidgets: true,
              scrollBeyondLastLine: false,
            }}
          />
        )}
      </div>
    </div>
  );
}
