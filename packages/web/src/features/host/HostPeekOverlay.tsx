import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { hostLabel, useHostInfo } from '../../lib/queries/queries';
import { registerHotkey, useHotkeyBindings } from '../../lib/navigation/hotkeys';
import { useClientSettings } from '../../lib/settings/client-settings';
import { desktopBridge } from '../../lib/desktop';
import { reducedMotion } from '../../lib/appearance/motion';
import { useCurrentProfileId } from '../profile/profile-store';
import { HostGlyph, useHostAppearance } from './host-appearance';
import '../../components/ui/overlay-motion.css';

/** A momentary identity glance. Never moves focus or remounts the workspace. */
export function HostPeekOverlay() {
  const host = useHostInfo();
  const { icon } = useHostAppearance();
  const profileId = useCurrentProfileId();
  const binding = useHotkeyBindings()['host.peek'];
  const { showHostOnFocus } = useClientSettings();
  const [visible, setVisible] = useState<'shortcut' | 'focus' | 'focus-closing' | null>(null);
  const isMac = /Mac/.test(navigator.platform);
  const held = useRef(false);
  const lastFocusSignal = useRef(-Infinity);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let away = document.hidden || !document.hasFocus();
    let lastShown = -Infinity;
    let nativeFocused: boolean | undefined;
    const clearTimer = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const hide = () => {
      clearTimer();
      held.current = false;
      setVisible(null);
    };
    const leave = () => {
      away = true;
      hide();
    };
    const returnToWindow = () => {
      // A visible tab/native focus notification can precede hasFocus() updating.
      if (document.hidden) return;
      const now = performance.now();
      const quiet = now - lastFocusSignal.current >= (isMac ? 750 : 250);
      // Leading-edge debounce: show immediately, never replay a trailing event.
      // Blur must not reset this; Spaces can send alternating blur/focus bursts.
      lastFocusSignal.current = now;
      const returning = away;
      away = false;
      if (!returning || !quiet || !showHostOnFocus || held.current) return;
      lastShown = now;
      clearTimer();
      setVisible('focus');
      timer = setTimeout(
        () => {
          if (!isMac || reducedMotion()) return hide();
          setVisible('focus-closing');
          timer = setTimeout(hide, 120);
        },
        isMac ? 400 : 1200,
      );
    };
    const dismissReminder = (event: Event) => {
      // Cmd-Tab can synchronise held modifier keys after activation. Likewise,
      // the click that raises a window must not immediately erase its reminder.
      if (event instanceof KeyboardEvent && ['Meta', 'Alt', 'Control', 'Shift'].includes(event.key))
        return;
      if (event.type === 'pointerdown' && performance.now() - lastShown < 100) return;
      // Let the same input reach the editor, terminal or clicked control.
      if (timer !== undefined) hide();
    };
    const parts = binding?.split('+') ?? [];
    const code = parts.at(-1);
    const modifierKeys: Record<string, string> = {
      Meta: 'meta',
      Control: 'ctrl',
      Alt: 'alt',
      Shift: 'shift',
    };
    const release = (event: KeyboardEvent) => {
      if (!held.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
      if (
        (event.type === 'keyup' &&
          (event.code === code ||
            parts.includes(
              modifierKeys[event.key] ??
                modifierKeys[event.code.replace(/(Left|Right)$/, '')] ??
                '',
            ))) ||
        event.key === 'Escape' ||
        (parts.includes('meta') && !event.metaKey) ||
        (parts.includes('ctrl') && !event.ctrlKey) ||
        (parts.includes('alt') && !event.altKey) ||
        (parts.includes('shift') && !event.shiftKey)
      )
        hide();
    };
    const visibility = () => {
      if (document.hidden) leave();
      else returnToWindow();
    };
    const unregister = registerHotkey('host.peek', () => {
      if (held.current || document.hidden) return;
      clearTimer();
      held.current = true;
      setVisible('shortcut');
    });
    window.addEventListener('keyup', release, true);
    window.addEventListener('keydown', release, true);
    window.addEventListener('blur', leave);
    window.addEventListener('pagehide', leave);
    window.addEventListener('focus', returnToWindow);
    window.addEventListener('keydown', dismissReminder, true);
    window.addEventListener('pointerdown', dismissReminder, true);
    window.addEventListener('wheel', dismissReminder, { passive: true, capture: true });
    document.addEventListener('visibilitychange', visibility);
    const offNativeFocus = desktopBridge()?.onWindowFocusChange?.((focused) => {
      const changed = focused !== nativeFocused;
      nativeFocused = focused;
      if (!focused) leave();
      else if (changed) {
        away = true;
        returnToWindow();
      }
    });
    return () => {
      offNativeFocus?.();
      unregister();
      window.removeEventListener('keyup', release, true);
      window.removeEventListener('keydown', release, true);
      window.removeEventListener('blur', leave);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('focus', returnToWindow);
      window.removeEventListener('keydown', dismissReminder, true);
      window.removeEventListener('pointerdown', dismissReminder, true);
      window.removeEventListener('wheel', dismissReminder, true);
      document.removeEventListener('visibilitychange', visibility);
      hide();
    };
  }, [binding, isMac, profileId, showHostOnFocus]);

  if (!visible) return null;
  return createPortal(
    <div
      data-host-peek
      data-state={
        visible === 'focus-closing'
          ? 'closed'
          : visible === 'focus' && isMac
            ? 'instant-open'
            : 'open'
      }
      className="overlay-backdrop-motion fixed inset-0 z-[200] flex items-center justify-center p-8 text-fg backdrop-blur-[8px]"
      style={
        visible !== 'shortcut'
          ? {
              pointerEvents: 'none',
              // Keep the final transparent frame until React removes the overlay.
              // Animation completion and the cleanup timer can land on different frames.
              ...(visible === 'focus-closing' ? { animationFillMode: 'forwards', opacity: 0 } : {}),
            }
          : undefined
      }
      onPointerDown={(event) => event.preventDefault()}
      role="status"
      aria-live="polite"
    >
      <div className="flex max-w-full flex-col items-center gap-6 px-12 py-10 text-center">
        <HostGlyph icon={icon} className="size-[clamp(4.5rem,13.5vmin,10.5rem)] shrink-0" />
        <span className="max-w-full break-words font-sans text-[clamp(0.8333rem,1.75vw,1.75rem)] leading-tight font-medium">
          {hostLabel(host.data) ?? 'Host'}
        </span>
      </div>
    </div>,
    document.body,
  );
}
