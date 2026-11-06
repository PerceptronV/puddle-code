import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { hostLabel, useHostInfo } from '../../lib/queries/queries';
import { registerHotkey, useHotkeyBindings } from '../../lib/navigation/hotkeys';
import { useCurrentProfileId } from '../profile/profile-store';
import { HostGlyph, useHostAppearance } from './host-appearance';
import '../../components/ui/overlay-motion.css';

/** A momentary identity glance. Never moves focus or remounts the workspace. */
export function HostPeekOverlay() {
  const host = useHostInfo();
  const { icon } = useHostAppearance();
  const profileId = useCurrentProfileId();
  const binding = useHotkeyBindings()['host.peek'];
  const [visible, setVisible] = useState(false);
  const held = useRef(false);

  useEffect(() => {
    const hide = () => {
      held.current = false;
      setVisible(false);
    };
    const parts = binding?.split('+') ?? [];
    const code = parts.at(-1);
    const release = (event: KeyboardEvent) => {
      if (!held.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
      if (
        (event.type === 'keyup' && event.code === code) ||
        event.key === 'Escape' ||
        (parts.includes('meta') && !event.metaKey) ||
        (parts.includes('ctrl') && !event.ctrlKey) ||
        (parts.includes('alt') && !event.altKey) ||
        (parts.includes('shift') && !event.shiftKey)
      )
        hide();
    };
    const visibility = () => {
      if (document.hidden) hide();
    };
    const unregister = registerHotkey('host.peek', () => {
      if (held.current || document.hidden) return;
      held.current = true;
      setVisible(true);
    });
    window.addEventListener('keyup', release, true);
    window.addEventListener('keydown', release, true);
    window.addEventListener('blur', hide);
    window.addEventListener('pagehide', hide);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      unregister();
      window.removeEventListener('keyup', release, true);
      window.removeEventListener('keydown', release, true);
      window.removeEventListener('blur', hide);
      window.removeEventListener('pagehide', hide);
      document.removeEventListener('visibilitychange', visibility);
      hide();
    };
  }, [binding, profileId]);

  if (!visible) return null;
  return createPortal(
    <div
      data-host-peek
      data-state="open"
      className="overlay-backdrop-motion fixed inset-0 z-[200] flex items-center justify-center p-8 text-fg backdrop-blur-[8px]"
      onPointerDown={(event) => event.preventDefault()}
      role="status"
      aria-live="polite"
    >
      <div className="flex max-w-full flex-col items-center gap-8 text-center">
        <HostGlyph icon={icon} className="size-[clamp(6rem,18vmin,14rem)] shrink-0" />
        <span className="max-w-full break-words font-sans text-[clamp(0.8333rem,2.3333vw,2.3333rem)] leading-tight font-medium">
          {hostLabel(host.data) ?? 'Host'}
        </span>
      </div>
    </div>,
    document.body,
  );
}
