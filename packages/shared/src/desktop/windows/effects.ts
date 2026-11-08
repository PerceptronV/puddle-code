import { z } from 'zod';

export const desktopWindowEffectsStatusSchema = z.object({
  hostOffers: z.boolean(),
  desktopOffers: z.boolean(),
});
export type DesktopWindowEffectsStatus = z.infer<typeof desktopWindowEffectsStatusSchema>;
export const desktopNotificationClaimSchema = z
  .object({
    id: z.string().min(1).max(256),
    /** Old status-only hosts lack unique event ids; their duplicate window deliveries expire. */
    legacy: z.boolean().optional(),
  })
  .strict();
export type DesktopNotificationClaim = z.infer<typeof desktopNotificationClaimSchema>;

/** Main elects live windows per registered host; callers cannot select another host. */
export interface DesktopWindowEffectsBridge {
  status(): Promise<DesktopWindowEffectsStatus>;
  onChanged(callback: (status: DesktopWindowEffectsStatus) => void): () => void;
  claimNotification(request: DesktopNotificationClaim): Promise<boolean>;
}
