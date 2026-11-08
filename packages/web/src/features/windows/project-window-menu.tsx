import { AppWindow, ArrowLeftToLine } from 'lucide-react';
import { ContextMenuItem } from '../../components/ui/context-menu';
import { desktopBridge } from '../../lib/desktop';
import { toastError } from '../../lib/transport/errors';
import { useCurrentProfileId } from '../profile/profile-store';
import { desktopWindowContext } from './window-context';
import { openProjectWindow } from './project-actions';

export function ProjectWindowMenu({ projectId }: { projectId: string }) {
  const profileId = useCurrentProfileId();
  const bridge = desktopBridge();
  const identity = desktopWindowContext()?.identity;
  if (!profileId || !bridge?.windows?.projects) return null;
  if (identity?.kind === 'project' && identity.projectId === projectId)
    return bridge.closeWindow ? (
      <ContextMenuItem onSelect={() => bridge.closeWindow?.()}>
        <ArrowLeftToLine />
        Return project to host
      </ContextMenuItem>
    ) : null;
  return (
    <ContextMenuItem
      onSelect={() => {
        void openProjectWindow(profileId, projectId).catch(toastError);
      }}
    >
      <AppWindow />
      Open project in window
    </ContextMenuItem>
  );
}
