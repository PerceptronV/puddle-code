import { useEffect, useRef, useState } from 'react';
import { desktopPaneDragPayloadSchema } from '@puddle/shared';
import { desktopBridge } from '../../../lib/desktop';
import { toastError } from '../../../lib/transport/errors';
import { currentProfileId } from '../../profile/profile-store';
import { desktopWindowContext } from '../window-context';

export const PROJECT_WINDOW_MIME = 'application/x-puddle-project-window';

export function canDragProjectWindow(projectId: string): boolean {
  const identity = desktopWindowContext()?.identity;
  return (
    identity?.kind === 'project' &&
    identity.projectId === projectId &&
    desktopBridge()?.windows?.transfers?.beginProjectDrag !== undefined
  );
}

/** Reuse the visible project label as the window's drag affordance. */
export function beginProjectWindowDrag(data: DataTransfer, projectId: string): boolean {
  if (!canDragProjectWindow(projectId)) return false;
  const context = desktopWindowContext()!;
  if (context.identity.kind !== 'project') return false;
  const { profileId } = context.identity;
  const token = crypto.randomUUID();
  data.setData(
    PROJECT_WINDOW_MIME,
    JSON.stringify({ token, sourceId: context.identity.id, hostId: context.hostId, profileId }),
  );
  data.effectAllowed = 'move';
  void desktopBridge()!.windows!.transfers!.beginProjectDrag!({
    token,
    profileId,
    projectId,
  }).catch(toastError);
  return true;
}

export async function dropProjectWindow(raw: string): Promise<void> {
  if (raw.length > 4096) throw new Error('Project drag is too large');
  const payload = desktopPaneDragPayloadSchema.parse(JSON.parse(raw));
  const context = desktopWindowContext();
  const bridge = desktopBridge()?.windows?.transfers;
  if (context?.identity.kind !== 'host' || !bridge?.dropProject)
    throw new Error('Return the project to a host window');
  if (context.hostId !== payload.hostId) throw new Error('Cannot transfer between hosts');
  if (currentProfileId() !== payload.profileId)
    throw new Error('Select the same profile in the host before returning the project');
  await bridge.dropProject({
    token: payload.token,
    sourceId: payload.sourceId,
    profileId: payload.profileId,
  });
}

/** Native capture precedes Monaco/xterm handlers and covers the dashboard too. */
export function useProjectWindowDrop() {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const enabled =
    desktopWindowContext()?.identity.kind === 'host' &&
    desktopBridge()?.windows?.transfers?.dropProject !== undefined;
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      clearTimeout(timer);
      setActive(false);
    };
    const carries = (event: DragEvent) => event.dataTransfer?.types.includes(PROJECT_WINDOW_MIME);
    const over = (event: DragEvent) => {
      if (!carries(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer!.dropEffect = 'move';
      setActive(true);
      clearTimeout(timer);
      timer = setTimeout(clear, 750);
    };
    const leave = (event: DragEvent) => {
      if (!el.contains(event.relatedTarget as Node | null)) clear();
    };
    const drop = (event: DragEvent) => {
      if (!carries(event)) return;
      event.preventDefault();
      event.stopPropagation();
      clear();
      void dropProjectWindow(event.dataTransfer!.getData(PROJECT_WINDOW_MIME)).catch(toastError);
    };
    el.addEventListener('dragenter', over, true);
    el.addEventListener('dragover', over, true);
    el.addEventListener('dragleave', leave, true);
    el.addEventListener('drop', drop, true);
    window.addEventListener('dragend', clear);
    window.addEventListener('blur', clear);
    return () => {
      clearTimeout(timer);
      el.removeEventListener('dragenter', over, true);
      el.removeEventListener('dragover', over, true);
      el.removeEventListener('dragleave', leave, true);
      el.removeEventListener('drop', drop, true);
      window.removeEventListener('dragend', clear);
      window.removeEventListener('blur', clear);
    };
  }, [enabled]);
  return { ref, active, enabled };
}
