import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DynamicIcon, iconNames, type IconName } from 'lucide-react/dynamic';
import { PROFILE_ICON_COLOURS, type Profile } from '@puddle/shared';
import { Input } from '../../../components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { usePatchProfile } from '../../../lib/queries';
import { cn } from '../../../lib/utils';
import { ProfileGlyph, profileColourClass } from '../../profile/ProfileGlyph';
import { SettingRow } from '../parts';

/** How many icons to render in the picker grid at once (each lazy-loads). */
const GRID_CAP = 60;

/**
 * Profile appearance (SPEC §11): pick any lucide icon and any theme colour for
 * the profile's glyph, shown wherever the profile appears (top bar, picker).
 */
export function ProfileAppearance({ profile }: { profile: Profile }) {
  const patch = usePatchProfile();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const names = q ? iconNames.filter((n) => n.includes(q)) : iconNames;
    return names.slice(0, GRID_CAP);
  }, [query]);

  const setIcon = (icon: string | null) => {
    patch.mutate({ id: profile.id, icon }, { onError: (e) => toast.error(e.message) });
    setOpen(false);
  };
  const setColour = (icon_colour: string | null) =>
    patch.mutate({ id: profile.id, icon_colour }, { onError: (e) => toast.error(e.message) });

  return (
    <>
      <SettingRow label="Icon" description="The glyph shown wherever this profile appears.">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex size-9 items-center justify-center rounded-md text-fg-gold transition-colors hover:bg-elevated hover:text-fg"
            >
              <ProfileGlyph icon={profile.icon} colour={profile.icon_colour} className="size-5" />
              <span className="sr-only">Choose an icon</span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72">
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search icons…"
              className="mb-2 h-8"
            />
            <div className="no-scrollbar grid max-h-64 grid-cols-8 gap-1 overflow-y-auto">
              <button
                type="button"
                title="Default"
                onClick={() => setIcon(null)}
                className={cn(
                  'flex aspect-square items-center justify-center rounded-md text-fg-secondary transition-colors hover:bg-elevated hover:text-fg',
                  !profile.icon && 'bg-elevated text-fg',
                )}
              >
                <ProfileGlyph icon={null} colour={null} className="size-4" />
              </button>
              {results.map((name) => (
                <button
                  key={name}
                  type="button"
                  title={name}
                  onClick={() => setIcon(name)}
                  className={cn(
                    'flex aspect-square items-center justify-center rounded-md text-fg-secondary transition-colors hover:bg-elevated hover:text-fg',
                    profile.icon === name && 'bg-elevated text-fg',
                  )}
                >
                  <DynamicIcon name={name as IconName} className="size-4" />
                </button>
              ))}
            </div>
            {results.length === 0 && (
              <p className="px-1 py-2 text-xs text-fg-muted">No icons match “{query}”.</p>
            )}
          </PopoverContent>
        </Popover>
      </SettingRow>

      <SettingRow label="Icon colour" description="Any theme colour; recolours with light/dark.">
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            title="Default"
            onClick={() => setColour(null)}
            className={cn(
              'flex size-7 items-center justify-center rounded-md transition-colors hover:bg-elevated',
              !profile.icon_colour && 'bg-elevated',
            )}
          >
            <span className="size-3.5 rounded-full bg-fg-muted" />
            <span className="sr-only">Default colour</span>
          </button>
          {PROFILE_ICON_COLOURS.map((key) => (
            <button
              key={key}
              type="button"
              title={key}
              onClick={() => setColour(key)}
              className={cn(
                'flex size-7 items-center justify-center rounded-md transition-colors hover:bg-elevated',
                profile.icon_colour === key && 'bg-elevated',
              )}
            >
              <span className={cn('size-3.5 rounded-full bg-current', profileColourClass(key))} />
              <span className="sr-only">{key}</span>
            </button>
          ))}
        </div>
      </SettingRow>
    </>
  );
}
