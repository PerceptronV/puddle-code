import { useEffect } from 'react';
import {
  actionForBinding,
  eventBinding,
  getHotkeyAction,
  getHotkeyHandler,
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const binding = eventBinding(e);
      if (!binding) return;
      const id = actionForBinding(binding);
      if (!id) return;
      const action = getHotkeyAction(id);
      if (!action || action.editor) return; // Monaco owns editor keys
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
