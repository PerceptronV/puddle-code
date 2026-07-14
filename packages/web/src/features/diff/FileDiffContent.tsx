import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import type { DiffEntry } from '@puddle/shared';
import { useClientSettings } from '../../lib/client-settings';
import { useFileAt } from '../../lib/worktree-queries';
import { ApiError } from '../../lib/api';
import { CodeEditor } from '../editor/CodeEditor';
import { bufferKey, releaseModel, retainModel } from '../editor/buffer-store';
import { monaco, THEME_NAME } from '../editor/monaco-setup';
import { useEditorBuffer } from '../editor/use-editor-buffer';

/**
 * A muted one-line note filling the section body (loading, binary, errors).
 * Exported: the history view (Task 9) reuses it verbatim for its own
 * loading/binary/error rows rather than redefining the same three lines.
 */
export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-xs text-fg-muted">
      {children}
    </div>
  );
}

/**
 * Retain the shared model for this key while the content is mounted and release
 * it on unmount (SPEC §8 refcount): the diff section is one holder, the editor
 * tab another, and the model is disposed only when the last lets go. Safe to
 * call before the model exists — the refcount is independent of the entry.
 *
 * Ordering matters: React 19 tears a deleted subtree down PARENT-FIRST
 * (react-dom 19.2.7 `commitPassiveUnmountEffectsInsideOfDeletedTree_begin`
 * runs hook cleanups on the way down), so this cleanup fires BEFORE any child
 * editor component's own unmount cleanup. If we are the last holder, the
 * release disposes the model while a child editor may still have it attached —
 * `detach` (when given) runs first to pull the model out of the editor. The
 * plain `<Editor>` path needs no detach: monaco 0.55.1's CodeEditorWidget
 * auto-detaches on `model.onWillDispose` (codeEditorWidget.js:1265); the
 * DiffEditorWidget does NOT (it logs a BugIndicatingError instead), hence
 * ModifiedContent's explicit detach.
 */
function useRetainedModel(key: string, detach?: () => void): void {
  const detachRef = useRef(detach);
  detachRef.current = detach;
  useEffect(() => {
    retainModel(key);
    return () => {
      detachRef.current?.();
      releaseModel(key);
    };
  }, [key]);
}

/**
 * A percent-encoded, uniquely-scheme'd URI for a throwaway read-only model.
 * Exported so every read-only viewer — this file's `ReadOnlyView`/
 * `DeletedContent`, and the history view's own private-model DiffEditor —
 * derives its model identity the same way, keeping "one model per (session,
 * ref, path)" a single rule rather than two copies that could drift.
 */
export function viewerUri(scheme: string, session: string, ref: string, path: string): string {
  const segments = path.split('/').map(encodeURIComponent).join('/');
  return `${scheme}://${encodeURIComponent(session)}/${encodeURIComponent(ref)}/${segments}`;
}

/**
 * Read-only Monaco viewer for content at a fixed ref (SPEC §8). Its own private
 * model (disposed on unmount via the default `keepCurrentModel: false`), never
 * a shared buffer — so history's sha→sha panes (Task 9) can reuse it as-is.
 */
export function ReadOnlyView({
  session,
  refName,
  path,
  content,
}: {
  session: string;
  refName: string;
  path: string;
  content: string;
}) {
  const fontMono = useMemo(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
      undefined,
    [],
  );
  return (
    <Editor
      path={viewerUri('puddle-view', session, refName, path)}
      defaultValue={content}
      theme={THEME_NAME}
      loading={<Note>…</Note>}
      options={{
        readOnly: true,
        automaticLayout: true,
        fontFamily: fontMono,
        minimap: { enabled: false },
        fixedOverflowWidgets: true,
        scrollBeyondLastLine: false,
      }}
    />
  );
}

/**
 * `deleted`: the base content, read-only, with a "Deleted" note. `against` is
 * just a ref string, so the history view (Task 9) reuses this unchanged for
 * a `sha^` original rather than a working-tree base — the read-only
 * semantics are identical either way.
 */
export function DeletedContent({
  session,
  against,
  path,
}: {
  session: string;
  against: string;
  path: string;
}) {
  const base = useFileAt(session, against, path);
  if (base.isPending) return <Note>…</Note>;
  if (base.error) {
    return <Note>{base.error instanceof Error ? base.error.message : 'Failed to load'}</Note>;
  }
  if (base.data.binary) return <Note>Binary file — deleted</Note>;
  return (
    <div className="flex h-full flex-col">
      <div className="bg-surface px-4 py-1 text-xs text-fg-muted">Deleted</div>
      <div className="min-h-0 flex-1">
        <ReadOnlyView
          session={session}
          refName={against}
          path={path}
          content={base.data.content ?? ''}
        />
      </div>
    </div>
  );
}

/** `modified`/`renamed`: base (read-only) vs. the SHARED editor buffer. */
function ModifiedContent({
  session,
  against,
  path,
  basePath,
}: {
  session: string;
  against: string;
  path: string;
  basePath: string;
}) {
  const settings = useClientSettings();
  // NB: when the same file is also open as an editor tab, its useEditorBuffer
  // instance and this one BOTH persist a draft per keystroke. The writes are
  // idempotent (same key, same content, debounced) — merely duplicated — and
  // there is no clean focus-ownership seam today, so this is left as is.
  const buffer = useEditorBuffer(session, path, null);
  const base = useFileAt(session, against, basePath);

  // Detach-before-release (see useRetainedModel): pull both models out of the
  // diff editor, then dispose the private original-side model ourselves — the
  // wrapper's later cleanup sees getModel() === null and no-ops, so the
  // original would otherwise leak.
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  useRetainedModel(bufferKey(session, path), () => {
    const editor = diffEditorRef.current;
    if (!editor) return;
    const models = editor.getModel();
    editor.setModel(null);
    models?.original.dispose();
    diffEditorRef.current = null;
  });

  const saveRef = useRef(buffer.save);
  saveRef.current = buffer.save;

  const fontMono = useMemo(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
      undefined,
    [],
  );

  // The base blob does not exist at the ref (`not_at_ref`): treat as a new file
  // and render it as a plain editable buffer, not a diff (SPEC §8).
  const baseMissing = base.error instanceof ApiError && base.error.status === 404;

  if (buffer.status === 'binary' || base.data?.binary) return <Note>Binary file</Note>;
  if (buffer.status === 'too-large') return <Note>File too large to show</Note>;
  if (buffer.status === 'error') return <Note>{buffer.errorMessage ?? 'Failed to load file'}</Note>;
  if (baseMissing) return <CodeEditor session={session} path={path} reveal={null} />;
  if (base.isPending || !buffer.model) return <Note>…</Note>;
  if (base.error) {
    return <Note>{base.error instanceof Error ? base.error.message : 'Failed to load base'}</Note>;
  }

  return (
    <DiffEditor
      // Binding the modified side to the shared buffer's own URI makes the
      // wrapper reuse that exact model (its `getModel(uri) ?? create` finds it),
      // so edits and dirty state flow straight into the editor tab's buffer —
      // no separate model, no content wipe. keepCurrentModifiedModel stops the
      // wrapper disposing it on unmount; our refcount owns disposal instead
      // (with the detach in useRetainedModel running first — see above).
      modifiedModelPath={buffer.model.uri.toString()}
      originalModelPath={viewerUri('puddle-base', session, against, basePath)}
      original={base.data.content ?? ''}
      language={buffer.model.getLanguageId()}
      theme={THEME_NAME}
      keepCurrentModifiedModel
      loading={<Note>…</Note>}
      onMount={(diffEditor) => {
        diffEditorRef.current = diffEditor;
        // If the widget somehow disposes before our cleanup (it shouldn't —
        // parent-first ordering — but cheap insurance), drop the stale ref so
        // the detach never touches a disposed editor.
        diffEditor.onDidDispose(() => {
          diffEditorRef.current = null;
        });
        diffEditor
          .getModifiedEditor()
          .addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
      }}
      options={{
        readOnly: false,
        originalEditable: false,
        renderSideBySide: true,
        automaticLayout: true,
        fontFamily: fontMono,
        wordWrap: settings.editorWordWrap ? 'on' : 'off',
        minimap: { enabled: false },
        fixedOverflowWidgets: true,
        scrollBeyondLastLine: false,
      }}
    />
  );
}

/** `added` (and a base that 404s as `not_at_ref`): a plain editable buffer. */
function AddedContent({ session, path }: { session: string; path: string }) {
  useRetainedModel(bufferKey(session, path));
  // CodeEditor owns the shared buffer, save flow, and binary/too-large
  // fallbacks (SPEC §8: a new file renders as a plain editor, not a diff).
  return <CodeEditor session={session} path={path} reveal={null} />;
}

/**
 * The Monaco body for one diff entry, chosen by status (SPEC §8). `DiffTabBody`
 * renders it as a centre-editor diff tab; its hooks — and the shared-model
 * retain — run only while that tab is mounted. The modified side binds to the
 * file's shared editor buffer, so ⌘S here saves through the same path.
 */
export function FileDiffContent({
  session,
  against,
  entry,
}: {
  session: string;
  against: string;
  entry: DiffEntry;
}) {
  switch (entry.status) {
    case 'added':
      return <AddedContent session={session} path={entry.path} />;
    case 'deleted':
      return <DeletedContent session={session} against={against} path={entry.path} />;
    case 'modified':
    case 'renamed':
      return (
        <ModifiedContent
          session={session}
          against={against}
          path={entry.path}
          basePath={entry.old_path ?? entry.path}
        />
      );
    default:
      return null;
  }
}
