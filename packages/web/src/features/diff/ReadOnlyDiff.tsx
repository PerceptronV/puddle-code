import { useEffect, useId, useMemo, useRef } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { languageForPath } from '../editor/monaco/languages';
import { useFileEditorSettings } from '../editor/settings/file-editor-settings';
import { monaco, THEME_NAME } from '../editor/monaco/monaco-setup';
import { editorIndentationOptions } from '../editor/monaco/monaco-options';
import { useDiffViewState } from '../editor/monaco/monaco-view-state';
import { Note, viewerUri } from './FileDiffContent';

/**
 * A read-only Monaco diff between two fixed refs, wholly private models on
 * both sides — never the shared buffer-store, since a sha→sha comparison has
 * no notion of "the current editable draft" (SPEC §8, Task 9). Disposal
 * mirrors FileDiffContent's `ModifiedContent`: the DiffEditorWidget does not
 * auto-detach a disposed model (it logs a BugIndicatingError instead, per
 * that file's comment — monaco 0.55.1), so both `keepCurrent*Model` flags are
 * set and this component detaches (`setModel(null)`) before disposing either
 * model itself, rather than letting the library's own unmount path dispose a
 * still-attached model.
 */
export function ReadOnlyDiff({
  session,
  originalRef,
  originalPath,
  originalContent,
  modifiedRef,
  modifiedPath,
  modifiedContent,
  root,
}: {
  session: string;
  originalRef: string;
  originalPath: string;
  originalContent: string;
  modifiedRef: string;
  modifiedPath: string;
  modifiedContent: string;
  root?: string;
}) {
  const instance = useId();
  const settings = useFileEditorSettings();
  const restoreView = useDiffViewState([
    session,
    root,
    originalRef,
    originalPath,
    modifiedRef,
    modifiedPath,
  ]);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const fontMono = useMemo(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
      undefined,
    [],
  );

  useEffect(
    () => () => {
      const editor = editorRef.current;
      if (!editor) return;
      const models = editor.getModel();
      editor.setModel(null);
      models?.original.dispose();
      models?.modified.dispose();
      editorRef.current = null;
    },
    [],
  );

  return (
    <DiffEditor
      originalModelPath={viewerUri(
        'puddle-revision-original',
        session,
        `${instance}:${originalRef}:${root ?? ''}`,
        originalPath,
      )}
      modifiedModelPath={viewerUri(
        'puddle-revision-modified',
        session,
        `${instance}:${modifiedRef}:${root ?? ''}`,
        modifiedPath,
      )}
      language={settings.editorLanguage ?? languageForPath(modifiedPath)}
      original={originalContent}
      modified={modifiedContent}
      theme={THEME_NAME}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      loading={<Note>…</Note>}
      onMount={(editor) => {
        restoreView(editor);
        editorRef.current = editor;
        // Cheap insurance mirroring ModifiedContent — see that file's comment.
        editor.onDidDispose(() => {
          editorRef.current = null;
        });
      }}
      options={{
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true,
        automaticLayout: true,
        fontFamily: fontMono,
        fontSize: settings.editorFontSize,
        ...editorIndentationOptions(settings.editorTabSize),
        wordWrap: settings.editorWordWrap ? 'on' : 'off',
        minimap: { enabled: false },
        fixedOverflowWidgets: true,
        scrollBeyondLastLine: false,
      }}
    />
  );
}
