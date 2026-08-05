import { useEffect } from 'react';
import { desktopBridge } from '../../lib/desktop';
import {
  actionForBinding,
  eventBinding,
  getHotkeyAction,
  getHotkeyHandler,
  registerHotkey,
  setHotkeyOverrides,
} from '../../lib/hotkeys';
import { useProfileSettings } from '../../lib/queries';
import { useCurrentProfileId } from '../profile/profile-store';

/** A focused terminal owns its keys — the dispatcher yields ⌃A/⌃` etc. to it. */
function terminalFocused(): boolean {
  const el = document.activeElement;
  return el instanceof Element && el.closest('.xterm') !== null;
}

/**
 * Whether the caret is inside a Monaco editor, which binds the `editor: true`
 * actions on the instance itself. Outside one, those keys are the shell's to
 * dispatch — otherwise ⌘S in a rendered preview, or in a pane focused by its tab
 * chip, fell through to the browser's Save Page dialogue (SPEC §11).
 */
function monacoFocused(): boolean {
  const el = document.activeElement;
  return el instanceof Element && el.closest('.monaco-editor') !== null;
}

/**
 * Installs the one global hotkey dispatcher and keeps the effective bindings in
 * sync with the profile's overrides (SPEC §11). Mounted once in the shell.
 * Editor actions (save, word wrap) are bound inside Monaco, so the dispatcher
 * skips them here.
 */
export function HotkeysHost() {
  const profileId = useCurrentProfileId();
  const settings = useProfileSettings(profileId ?? undefined);
  const overrides = settings.data?.['hotkeys'];

  useEffect(() => {
    setHotkeyOverrides(
      overrides && typeof overrides === 'object'
        ? (overrides as Record<string, string>)
        : undefined,
    );
  }, [overrides]);

  // Closing the window is a shell action, not a workspace one: it belongs here
  // so it works on the dashboard too. In the desktop shell only the main
  // process can do it (a renderer's close() is ignored for a window it did not
  // open); in a browser tab the chrome has already acted on ⌘W by the time this
  // runs, and `window.close()` is the honest fallback for a script-opened one.
  useEffect(
    () =>
      registerHotkey('window.close', () => {
        const bridge = desktopBridge();
        if (bridge?.closeWindow) bridge.closeWindow();
        else window.close();
      }),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const binding = eventBinding(e);
      if (!binding) return;
      const id = actionForBinding(binding);
      if (!id) return;
      const action = getHotkeyAction(id);
      if (!action) return;
      if (action.editor && monacoFocused()) return; // the caret's editor owns them
      if (action.deferInTerminal && terminalFocused()) return;
      const handler = getHotkeyHandler(id);
      if (!handler) return;
      e.preventDefault();
      handler();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return null;
}
