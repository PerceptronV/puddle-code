import { desktopBridge } from '../../../lib/desktop';

/** Claim before looking up preferences or playing sound; native focus selects that decision's owner. */
export async function claimWindowNotification(id: string, legacy: boolean): Promise<boolean> {
  const effects = desktopBridge()?.windows?.effects;
  if (!effects) return true;
  try {
    return await effects.claimNotification({ id, ...(legacy ? { legacy: true } : {}) });
  } catch {
    // An uncertain IPC reply cannot authorise a second sound or OS notification.
    return false;
  }
}
