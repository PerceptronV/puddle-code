import { desktopBridge } from '../../../lib/desktop';

/** Claim after resolving the profile, before playing sound or delivering a notification. */
export async function claimWindowNotification(
  id: string,
  legacy: boolean,
  profileId: string,
): Promise<boolean> {
  const effects = desktopBridge()?.windows?.effects;
  if (!effects) return true;
  try {
    return await effects.claimNotification({
      id,
      ...(legacy ? { legacy: true } : {}),
      ...(effects.setNotificationProfile ? { profileId } : {}),
    });
  } catch {
    // An uncertain IPC reply cannot authorise a second sound or OS notification.
    return false;
  }
}
