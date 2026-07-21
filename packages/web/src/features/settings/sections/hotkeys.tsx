import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import {
  eventBinding,
  formatBinding,
  HOTKEY_ACTIONS,
  HOTKEY_GROUPS,
  isReservedBinding,
} from '../../../lib/hotkeys';
import { usePatchProfileSettings, useProfileSettings } from '../../../lib/queries';
import { cn } from '../../../lib/utils';
import { useCurrentProfileId } from '../../profile/profile-store';
import { SectionTitle, SettingRow } from '../parts';

/** Capture a keystroke and report its canonical binding (Esc cancels). */
function KeyRecorder({
  value,
  isDefault,
  onRecord,
  onReset,
}: {
  value: string;
  isDefault: boolean;
  onRecord: (binding: string) => void;
  onReset: () => void;
}) {
  const [recording, setRecording] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return;
          // Keep the keystroke here: don't let the global dispatcher or the
          // browser act on it while we're capturing it.
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Escape') {
            setRecording(false);
            return;
          }
          const binding = eventBinding(e.nativeEvent);
          if (binding) {
            onRecord(binding);
            setRecording(false);
          }
        }}
        className={cn(
          'min-w-24 rounded-md px-2 py-1 text-center font-mono text-xs transition-colors',
          recording ? 'bg-action text-action-ink' : 'bg-elevated text-fg hover:bg-border/70',
        )}
      >
        {recording ? 'Press keys…' : formatBinding(value)}
      </button>
      {!isDefault && (
        <button
          type="button"
          title="Reset to default"
          onClick={onReset}
          className="rounded-md p-1 text-fg-gold transition-colors hover:bg-elevated hover:text-fg"
        >
          <RotateCcw className="size-3.5" />
          <span className="sr-only">Reset to default</span>
        </button>
      )}
    </div>
  );
}

export function HotkeysSection() {
  const profileId = useCurrentProfileId();
  const settings = useProfileSettings(profileId ?? undefined);
  const patch = usePatchProfileSettings(profileId ?? '');
  const overrides = (settings.data?.['hotkeys'] as Record<string, string> | undefined) ?? {};

  const effective = (id: string, def: string) => overrides[id] || def;
  // Count each binding across all actions, to flag a clash on both rows.
  const counts = new Map<string, number>();
  for (const a of HOTKEY_ACTIONS) {
    const b = effective(a.id, a.defaultBinding);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }

  const save = (id: string, binding: string) =>
    patch.mutate(
      { hotkeys: { ...overrides, [id]: binding } },
      { onError: (e) => toast.error(e.message) },
    );
  const reset = (id: string) => {
    const rest = { ...overrides };
    delete rest[id];
    patch.mutate({ hotkeys: rest }, { onError: (e) => toast.error(e.message) });
  };

  return (
    <div>
      <SectionTitle>Hotkeys</SectionTitle>
      <p className="mb-4 text-xs text-fg-muted">
        Per-profile keyboard shortcuts. Filetree navigation and terminal line-edits are fixed.
        Browser-reserved combos (⌘W, ⌘T, ⌘⇧B, …) can’t be captured by a web tab.
      </p>
      {HOTKEY_GROUPS.map((group) => {
        const actions = HOTKEY_ACTIONS.filter((a) => a.group === group);
        if (actions.length === 0) return null;
        return (
          <div key={group} className="mb-5">
            <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-fg-gold">
              {group}
            </div>
            {actions.map((a) => {
              const binding = effective(a.id, a.defaultBinding);
              const clash = (counts.get(binding) ?? 0) > 1;
              const reserved = isReservedBinding(binding);
              const warn = reserved
                ? 'Browser-reserved — won’t fire in a tab.'
                : clash
                  ? 'Conflicts with another shortcut.'
                  : undefined;
              return (
                <SettingRow
                  key={a.id}
                  label={a.label}
                  description={warn}
                  descriptionClassName={warn ? 'text-interrupted' : undefined}
                >
                  <KeyRecorder
                    value={binding}
                    isDefault={!overrides[a.id]}
                    onRecord={(b) => save(a.id, b)}
                    onReset={() => reset(a.id)}
                  />
                </SettingRow>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
