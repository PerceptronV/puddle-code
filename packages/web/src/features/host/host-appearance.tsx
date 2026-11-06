import { isCustomColour } from '../../lib/appearance/appearance-colours';
import { hostPalette } from './host-palette';
import {
  cssTokenReader,
  currentTheme,
  onThemeChange,
  notifyThemeChange,
} from '../../lib/appearance/theme';
import { useLayoutEffect, type ReactNode } from 'react';
import { PROFILE_ICON_COLOURS } from '@puddle/shared';
import { Server } from 'lucide-react';
import { useProfileSettings } from '../../lib/queries/queries';
import { useCurrentProfileId } from '../profile/profile-store';
import { HOST_ICON_BY_NAME } from './host-icons';
import './host-appearance.css';

/** Profile settings live on the connected daemon, so this is naturally (host, profile). */
export function useHostAppearance(enabled = true) {
  const profileId = useCurrentProfileId();
  const settings = useProfileSettings(enabled ? (profileId ?? undefined) : undefined);
  const colour = settings.data?.hostColour;
  return {
    icon: settings.data?.hostIcon,
    colour:
      PROFILE_ICON_COLOURS.some((key) => key === colour) || isCustomColour(colour) ? colour : null,
  };
}

export function HostGlyph({
  icon,
  className = 'size-4 shrink-0',
}: {
  icon?: string | null;
  className?: string;
}) {
  const Icon =
    (icon && Object.hasOwn(HOST_ICON_BY_NAME, icon) && HOST_ICON_BY_NAME[icon]) || Server;
  return <Icon className={className} aria-hidden="true" />;
}

/** Use inside an already admitted host connection; never reads another host's cache. */
export function HostIdentity({ name, enabled = true }: { name: string; enabled?: boolean }) {
  const { icon, colour } = useHostAppearance(enabled);
  return (
    <span
      data-host-colour={colour ?? undefined}
      className="host-identity inline-flex min-w-0 items-center gap-2"
    >
      <HostGlyph icon={icon} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** The window shows one host at a time. Root scope also reaches portalled dialogues. */
export function HostAppearanceTheme({ enabled = true }: { enabled?: boolean }) {
  const { colour } = useHostAppearance(enabled);
  useLayoutEffect(() => {
    const root = document.documentElement;
    let keys: string[] = [];
    const clear = () => {
      for (const key of keys) root.style.removeProperty(key);
      keys = [];
      delete root.dataset.hostColour;
    };
    const apply = () => {
      clear();
      if (!colour) return;
      const palette = hostPalette(colour, currentTheme(), cssTokenReader());
      keys = Object.keys(palette);
      for (const [key, value] of Object.entries(palette)) root.style.setProperty(key, value);
      root.dataset.hostColour = colour;
    };
    apply();
    // Run before editor/terminal subscribers read their next theme.
    const off = onThemeChange(apply, { first: true });
    notifyThemeChange();
    return () => {
      off();
      clear();
      notifyThemeChange();
    };
  }, [colour]);
  return null;
}

export function HostHeader({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const { colour } = useHostAppearance(enabled);
  return (
    <header className="remote-topbar host-header" data-host-colour={colour ?? undefined}>
      {children}
    </header>
  );
}
