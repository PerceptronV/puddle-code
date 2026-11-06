import { useState } from 'react';
import { toastError } from '../../../lib/transport/errors';

import { ColourPicker } from '../../../components/colour-picker';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { customHostColourSupported } from '../../../lib/transport/protocol-support';
import {
  useDaemonVersion,
  usePatchProfileSettings,
  useProfileSettings,
} from '../../../lib/queries/queries';
import { cn } from '../../../lib/utils';
import { HostGlyph } from '../../host/host-appearance';
import { useCurrentProfileId } from '../../profile/profile-store';
import { HOST_ICONS } from '../../host/host-icons';
import { SettingRow } from '../parts';

/** This profile's identity for the connected host, outside Settings Sync. */
export function HostAppearance() {
  const profileId = useCurrentProfileId();
  const version = useDaemonVersion();
  const settings = useProfileSettings(profileId ?? undefined);
  const patch = usePatchProfileSettings(profileId ?? '');
  const [open, setOpen] = useState(false);
  if (!profileId || !settings.data) return null;
  const icon = settings.data.hostIcon;
  const colour = settings.data.hostColour;
  const setIcon = (hostIcon: string | null) => {
    patch.mutate({ hostIcon }, { onError: toastError });
    setOpen(false);
  };
  const setColour = (hostColour: string | null) =>
    patch.mutate({ hostColour }, { onError: toastError });

  return (
    <>
      <SettingRow label="Icon">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-host-colour={colour ?? undefined}
              className="host-identity flex size-9 items-center justify-center rounded-md transition-colors hover:bg-elevated hover:text-fg"
            >
              <HostGlyph icon={icon} className="size-5" />
              <span className="sr-only">Choose a host icon</span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72">
            <div className="grid grid-cols-8 gap-1">
              <button
                type="button"
                title="Default host icon"
                aria-pressed={!icon}
                onClick={() => setIcon(null)}
                className={cn(
                  'flex h-8 items-center justify-center rounded-md text-fg-secondary transition-colors hover:bg-elevated hover:text-fg',
                  !icon && 'bg-nav-selection text-nav-selection-ink',
                )}
              >
                <HostGlyph icon={null} className="size-4" />
              </button>
              {HOST_ICONS.map(({ name, Icon }) => (
                <button
                  key={name}
                  type="button"
                  title={name}
                  aria-pressed={icon === name}
                  onClick={() => setIcon(name)}
                  className={cn(
                    'flex h-8 items-center justify-center rounded-md text-fg-secondary transition-colors hover:bg-elevated hover:text-fg',
                    icon === name && 'bg-nav-selection text-nav-selection-ink',
                  )}
                >
                  <Icon className="size-4" />
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </SettingRow>

      <SettingRow label="Accent">
        <ColourPicker
          onCustomChange={customHostColourSupported(version.data?.protocol) ? setColour : undefined}
          value={colour}
          onChange={setColour}
          label="Host accent"
        />
      </SettingRow>
    </>
  );
}
