import { useState, type ReactNode } from 'react';
import type { DesktopDockTarget } from '@puddle/shared';
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
import { openPaneWindow, dockPaneWindow } from './use-window-transfer';

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
  const [targets, setTargets] = useState<DesktopDockTarget[]>([]);
  const bridge = desktopBridge()?.windows?.transfers;
  const detached = desktopWindowContext()?.identity.kind === 'pane';
  if (!bridge || (detached && !bridge.dockTargets) || !projectId || !profileId) return children;
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open && detached) void bridge.dockTargets!(profileId).then(setTargets, toastError);
      }}
    >
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {detached ? (
          targets.length ? (
            targets.map((target) => (
              <ContextMenuItem
                key={target.identity.id}
                onSelect={() => {
                  void dockPaneWindow(profileId, projectId, paneId, target.identity.id).catch(
                    toastError,
                  );
                }}
              >
                <AppWindow /> Return pane to {target.label}
              </ContextMenuItem>
            ))
          ) : (
            <ContextMenuItem disabled>
              Open a host or project window to return this pane
            </ContextMenuItem>
          )
        ) : (
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
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
