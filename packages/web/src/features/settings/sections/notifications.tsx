import { useEffect, useState } from 'react';
import { toastError } from '../../../lib/errors';
import { Switch } from '../../../components/ui/switch';
import {
  notificationPermission,
  type EffectiveNotificationPermission,
} from '../../../lib/notification-permission';
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
 * The live browser permission behind the desktop toggle. Re-read on window
 * focus: granting or revoking happens in the browser's own UI (the prompt, a
 * site-settings page, System Settings), and the user comes back here to see
 * whether it took.
 */
function usePermissionState(): [EffectiveNotificationPermission, () => void] {
  const [permission, setPermission] = useState(notificationPermission);
  const refresh = () => setPermission(notificationPermission());
  useEffect(() => {
    const onFocus = () => setPermission(notificationPermission());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  return [permission, refresh];
}

/** The warning under the desktop toggle when it is on but cannot deliver. */
function PermissionHint({
  permission,
  onRequest,
}: {
  permission: EffectiveNotificationPermission;
  onRequest: () => void;
}) {
  if (permission === 'granted') return null;
  return (
    <p className="pb-2 text-xs text-warning">
      {permission === 'default' && (
        <>
          The browser has not been asked for permission yet, so nothing will show —{' '}
          <button
            type="button"
            onClick={onRequest}
            className="underline underline-offset-2 transition-colors hover:text-fg"
          >
            request it now
          </button>
          .
        </>
      )}
      {permission === 'denied' &&
        'Blocked by the browser — allow notifications for this site in its site settings, then return here.'}
      {permission === 'unsupported' && 'This browser cannot show desktop notifications.'}
    </p>
  );
}

/**
 * Notification preferences (SPEC §11); delivery lives in the shell's
 * use-waiting-notifications hook, which reads this profile-settings shape.
 * The desktop toggle's browser permission is requested by a click on the
 * toggle or the inline hint (a user gesture is required), and the row shows
 * the live permission state — the toggle defaults to on, so without the hint
 * an ungranted browser would silently deliver nothing.
 */
export function NotificationsSection() {
  const profileId = useCurrentProfileId();
  const settings = useProfileSettings(profileId ?? undefined);
  const patch = usePatchProfileSettings(profileId ?? '');
  const projects = useProjects(profileId ?? undefined);
  const [permission, refreshPermission] = usePermissionState();

  const prefs: NotificationPrefs = {
    ...DEFAULTS,
    ...((settings.data?.['notifications'] as Partial<NotificationPrefs> | undefined) ?? {}),
  };
  const save = (next: NotificationPrefs) =>
    patch.mutate({ notifications: next }, { onError: (e) => toastError(e) });

  const requestPermission = () => {
    if (typeof Notification === 'undefined') return;
    void Notification.requestPermission().then(refreshPermission);
  };

  return (
    <div>
      <SectionTitle>Notifications</SectionTitle>
      <SettingRow
        label="Desktop notification on waiting"
        htmlFor="notify-desktop"
      >
        <Switch
          id="notify-desktop"
          checked={prefs.desktop}
          onCheckedChange={(checked) => {
            // The toggle click is the user gesture browsers require for the
            // permission prompt — ask here, not at delivery time.
            if (checked) requestPermission();
            save({ ...prefs, desktop: checked });
          }}
        />
      </SettingRow>
      {prefs.desktop && <PermissionHint permission={permission} onRequest={requestPermission} />}
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
