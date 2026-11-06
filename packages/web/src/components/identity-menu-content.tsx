import { useState } from 'react';
import { Palette, Pencil, RefreshCw } from 'lucide-react';
import { ColourPicker } from './colour-picker';
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from './ui/context-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';

/** Shared header identity actions; writes stay with the owning host/profile store. */
export function IdentityMenuContent({
  kind,
  colour,
  onRename,
  onColour,
  custom = true,
  pending = false,
  onUpdates,
}: {
  kind: 'host' | 'profile';
  colour: string | null | undefined;
  onRename: () => void;
  onColour: (colour: string | null) => void;
  custom?: boolean;
  pending?: boolean;
  onUpdates?: () => void;
}) {
  const [choosingColour, setChoosingColour] = useState(false);
  return (
    <>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onRename}>
          <Pencil />
          Rename {kind}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => setChoosingColour(true)}>
          <Palette />
          Change {kind} colour
        </ContextMenuItem>
        {onUpdates && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onUpdates}>
              <RefreshCw />
              Host updates
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
      <Dialog open={choosingColour} onOpenChange={setChoosingColour}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{kind === 'host' ? 'Host accent' : 'Profile colour'}</DialogTitle>
          </DialogHeader>
          <ColourPicker
            value={colour}
            onChange={onColour}
            onCustomChange={custom ? onColour : undefined}
            disabled={pending}
            label={kind === 'host' ? 'Host accent' : 'Profile colour'}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
