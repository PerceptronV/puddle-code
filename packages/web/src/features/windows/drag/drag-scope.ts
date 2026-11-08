import { desktopDragScopeSchema } from '@puddle/shared';
import { currentProfileId } from '../../profile/profile-store';
import { desktopWindowContext } from '../window-context';

export function windowDragScope() {
  const context = desktopWindowContext();
  if (!context) return null;
  const profileId = currentProfileId();
  return profileId ? { sourceId: context.identity.id, hostId: context.hostId, profileId } : null;
}

export function isLocalDragScope(value: unknown): boolean {
  const scope = desktopDragScopeSchema.safeParse(value);
  const current = windowDragScope();
  return (
    !!current &&
    scope.success &&
    scope.data.sourceId === current.sourceId &&
    scope.data.hostId === current.hostId &&
    scope.data.profileId === current.profileId
  );
}

/** Filesystem moves, archive batches and list reorders never cross native windows. */
export function encodeLocalDrag(payload: unknown): string {
  return JSON.stringify(desktopWindowContext() ? { window: windowDragScope(), payload } : payload);
}

export function decodeLocalDrag(raw: string): unknown {
  if (raw.length > 4 * 1024 * 1024) return null;
  const value: unknown = JSON.parse(raw);
  if (!desktopWindowContext()) return value;
  if (!value || typeof value !== 'object' || !('window' in value) || !('payload' in value))
    return null;
  return isLocalDragScope(value.window) ? value.payload : null;
}
