import type { ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { AppWindow } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '../../components/ui/context-menu';
import { desktopBridge } from '../../lib/desktop';
import { toastError } from '../../lib/transport/errors';
import { useCurrentProfileId } from '../profile/profile-store';
import { desktopWindowContext } from './window-context';
import { openPaneWindow } from './use-window-transfer';

export function PaneWindowContextMenu({
  paneId,
  children,
}: {
  paneId: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const { id: projectId } = useParams();
  const profileId = useCurrentProfileId();
  if (
    !desktopBridge()?.windows?.transfers ||
    desktopWindowContext()?.identity.kind === 'pane' ||
    !projectId ||
    !profileId
  )
    return children;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => {
            void openPaneWindow(profileId, projectId, paneId).then(
              () => navigate(`/project/${projectId}`, { replace: true }),
              toastError,
            );
          }}
        >
          <AppWindow /> Open pane in window
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
