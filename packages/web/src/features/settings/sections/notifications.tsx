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
 * Notification preferences (SPEC §11); delivery lives in the shell's
 * use-waiting-notifications hook, which reads this profile-settings shape.
 * Enabling the desktop toggle asks the browser for permission there and then —
 * a user gesture is required, and this click is it.
 */
export function NotificationsSection() {
  const profileId = useCurrentProfileId();
  const settings = useProfileSettings(profileId ?? undefined);
  const patch = usePatchProfileSettings(profileId ?? '');
  const projects = useProjects(profileId ?? undefined);

  const prefs: NotificationPrefs = {
    ...DEFAULTS,
    ...((settings.data?.['notifications'] as Partial<NotificationPrefs> | undefined) ?? {}),
  };
  const save = (next: NotificationPrefs) =>
    patch.mutate({ notifications: next }, { onError: (e) => toast.error(e.message) });

  return (
    <div>
      <SectionTitle note="When an agent flips to waiting for input">Notifications</SectionTitle>
      <SettingRow
        label="Desktop notification on waiting"
        description="Shown while this window is unfocused; clicking it opens the session."
        htmlFor="notify-desktop"
      >
        <Switch
          id="notify-desktop"
          checked={prefs.desktop}
          onCheckedChange={(checked) => {
            // The toggle click is the user gesture browsers require for the
            // permission prompt — ask here, not at delivery time.
            if (checked && typeof Notification !== 'undefined') {
              void Notification.requestPermission();
            }
            save({ ...prefs, desktop: checked });
          }}
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
