import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { monaco, THEME_NAME } from './monaco-setup';
import { editorIndentationOptions } from './monaco-options';
import { registerEditorKeybindings } from './editor-keybindings';
import { useClientSettings } from '../../lib/client-settings';

/** Cell models survive viewport eviction; their owning cell disposes them on removal. */
export function NotebookCellEditor({
  value,
  language,
  label,
  focus,
  onChange,
  onExecute,
  onEscape,
  onSplit,
  onSave,
}: {
  value: string;
  language: string;
  label: string;
  focus: boolean;
  onChange: (value: string) => void;
  onExecute: (mode: 'stay' | 'next' | 'insert') => void;
  onEscape: () => void;
  onSplit: (offset: number) => void;
  onSave: () => void;
}) {
  const settings = useClientSettings();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const model = useRef<monaco.editor.ITextModel | null>(null);
  const syncing = useRef(false);
  const view = useRef<monaco.editor.ICodeEditorViewState | null>(null);
  const callbacks = useRef({ onChange, onExecute, onEscape, onSplit, onSave });
  callbacks.current = { onChange, onExecute, onEscape, onSplit, onSave };
  const [visible, setVisible] = useState(false);
  const [height, setHeight] = useState(Math.max(64, value.split('\n').length * 22 + 24));
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), {
      rootMargin: '600px',
    });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(
    () => () => {
      model.current?.dispose();
    },
    [],
  );
  useEffect(() => {
    const current = model.current;
    if (current && current.getValue() !== value) {
      syncing.current = true;
      current.pushEditOperations(
        [],
        [{ range: current.getFullModelRange(), text: value }],
        () => null,
      );
      syncing.current = false;
    }
    if (current) monaco.editor.setModelLanguage(current, language);
  }, [value, language]);
  useEffect(() => {
    if (focus) editor.current?.focus();
  }, [focus]);
  return (
    <div ref={host} style={{ height }} className="min-w-0 rounded-md bg-surface">
      {(visible || focus) && (
        <Editor
          theme={THEME_NAME}
          defaultValue={value}
          defaultLanguage={language}
          keepCurrentModel
          saveViewState={false}
          onMount={(instance) => {
            if (model.current) {
              const temporary = instance.getModel();
              instance.setModel(model.current);
              if (temporary !== model.current) temporary?.dispose();
            } else model.current = instance.getModel();
            editor.current = instance;
            registerEditorKeybindings(instance, { onSave: () => callbacks.current.onSave() });
            if (view.current) instance.restoreViewState(view.current);
            const resize = () => setHeight(Math.max(64, instance.getContentHeight()));
            const size = instance.onDidContentSizeChange(resize);
            const change = instance.onDidChangeModelContent(() => {
              if (!syncing.current) callbacks.current.onChange(instance.getValue());
            });
            const scroll = instance.onDidScrollChange(() => {
              view.current = instance.saveViewState();
            });
            const cursor = instance.onDidChangeCursorSelection(() => {
              view.current = instance.saveViewState();
            });
            instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
              callbacks.current.onExecute('stay'),
            );
            instance.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () =>
              callbacks.current.onExecute('next'),
            );
            instance.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () =>
              callbacks.current.onExecute('insert'),
            );
            instance.addCommand(
              monaco.KeyCode.Escape,
              () => callbacks.current.onEscape(),
              '!suggestWidgetVisible && !findWidgetVisible',
            );
            instance.addCommand(
              monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Minus,
              () => {
                const position = instance.getPosition();
                if (position) callbacks.current.onSplit(instance.getModel()!.getOffsetAt(position));
              },
            );
            instance.onDidDispose(() => {
              size.dispose();
              scroll.dispose();
              cursor.dispose();
              change.dispose();
              editor.current = null;
            });
            resize();
            if (focus) instance.focus();
          }}
          beforeMount={() => {
            if (model.current) monaco.editor.setModelLanguage(model.current, language);
          }}
          options={{
            ariaLabel: label,
            automaticLayout: true,
            fontFamily: getComputedStyle(document.documentElement)
              .getPropertyValue('--font-mono')
              .trim(),
            fontSize: settings.editorFontSize,
            ...editorIndentationOptions(settings.editorTabSize),
            wordWrap: settings.editorWordWrap ? 'on' : 'off',
            minimap: { enabled: false },
            glyphMargin: false,
            folding: true,
            lineNumbers: 'off',
            lineDecorationsWidth: 8,
            lineNumbersMinChars: 3,
            scrollBeyondLastLine: false,
            fixedOverflowWidgets: true,
            padding: { top: 12, bottom: 12 },
            renderLineHighlight: 'none',
            // Monaco 0.55's delayed word highlighter rejects on short-lived cell disposal.
            occurrencesHighlight: 'off',
            scrollbar: { alwaysConsumeMouseWheel: false },
          }}
          onChange={() => {
            if (editor.current) view.current = editor.current.saveViewState();
          }}
        />
      )}
    </div>
  );
}
