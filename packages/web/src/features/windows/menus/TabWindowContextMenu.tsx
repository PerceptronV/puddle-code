import type { ReactNode } from 'react';
import type { TabRef } from '@puddle/shared';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../../../components/ui/context-menu';
import { useOpenTabWindow } from '../transfers/use-window-transfer';

/** Untitled/diff/preview tabs share the native action without acquiring file-system actions. */
export function TabWindowContextMenu({
  tab,
  paneId,
  children,
}: {
  tab: TabRef;
  paneId: string;
  children: ReactNode;
}) {
  const openWindow = useOpenTabWindow(tab, { paneId });
  if (!openWindow) return children;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={openWindow}>Open file in window</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
