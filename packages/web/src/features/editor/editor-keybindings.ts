import { clientSettings, updateClientSettings } from '../../lib/client-settings';
import { nextWordWrap } from './editor-keybindings-logic';
import { monaco } from './monaco-setup';

/**
 * Register puddle's Monaco keybindings on an editor instance (SPEC §8), in one
 * place so a new binding is a one-liner:
 *
 * - `⌘/Ctrl+S` — save (delegated to the buffer's save).
 * - `⌥Z` — toggle line wrap. It flips the `editorWordWrap` **client setting**,
 *   which every open editor's `wordWrap` option is bound to, so the change
 *   applies live to all editors and persists (VSCode's view-toggle, made sticky).
 *
 * Monaco's stock bindings (multi-cursor, `⌘/` comment, find/replace) are left
 * as they ship.
 */
export function registerEditorKeybindings(
  editor: monaco.editor.IStandaloneCodeEditor,
  opts: { onSave: () => void },
): void {
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => opts.onSave());
  editor.addAction({
    id: 'puddle.toggleWordWrap',
    label: 'Toggle Word Wrap',
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
    run: () =>
      updateClientSettings({ editorWordWrap: nextWordWrap(clientSettings().editorWordWrap) }),
  });
}
