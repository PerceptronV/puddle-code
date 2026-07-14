import { toast } from 'sonner';
import { Switch } from '../../../components/ui/switch';
import { usePatchProfileSettings, useProfileSettings, useProjects } from '../../../lib/queries';
import { useCurrentProfileId } from '../../profile/profile-store';
import { SectionTitle, SettingRow } from '../parts';

interface NotificationPrefs {
  desktop: boolean;
  sound: boolean;
  muted_projects: string[]; // project ids (10-hex)
}

const DEFAULTS: NotificationPrefs = { desktop: true, sound: false, muted_projects: [] };

/**
 * Preference storage only in Phase 2 — the notifications themselves land in
 * Phase 8, which reads this profile-settings shape as-is.
 */
export function NotificationsSection() {
  const profileId = useCurrentProfileId();
  const settings = useProfileSettings(profileId ?? undefined);
  const patch = usePatchProfileSettings(profileId ?? 0);
  const projects = useProjects(profileId ?? undefined);

  const prefs: NotificationPrefs = {
    ...DEFAULTS,
    ...((settings.data?.['notifications'] as Partial<NotificationPrefs> | undefined) ?? {}),
  };
  const save = (next: NotificationPrefs) =>
    patch.mutate({ notifications: next }, { onError: (e) => toast.error(e.message) });

  return (
    <div>
      <SectionTitle note="Delivery lands in a later phase">Notifications</SectionTitle>
      <SettingRow
        label="Desktop notification on waiting"
        description="When a session flips to waiting for input."
        htmlFor="notify-desktop"
      >
        <Switch
          id="notify-desktop"
          checked={prefs.desktop}
          onCheckedChange={(checked) => save({ ...prefs, desktop: checked })}
        />
      </SettingRow>
      <SettingRow label="Sound" htmlFor="notify-sound">
        <Switch
          id="notify-sound"
          checked={prefs.sound}
          onCheckedChange={(checked) => save({ ...prefs, sound: checked })}
        />
      </SettingRow>
      <SettingRow label="Muted projects" description="No notifications from these projects.">
        <span className="text-2xs text-fg-muted tabular-nums">
          {prefs.muted_projects.length} muted
        </span>
      </SettingRow>
      <div className="flex flex-col gap-1">
        {projects.data?.map((project) => {
          const muted = prefs.muted_projects.includes(project.id);
          return (
            <label
              key={project.id}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-fg-secondary hover:bg-elevated"
            >
              <Switch
                checked={muted}
                onCheckedChange={(checked) =>
                  save({
                    ...prefs,
                    muted_projects: checked
                      ? [...prefs.muted_projects, project.id]
                      : prefs.muted_projects.filter((id) => id !== project.id),
                  })
                }
              />
              {project.name}
            </label>
          );
        })}
      </div>
    </div>
  );
}
