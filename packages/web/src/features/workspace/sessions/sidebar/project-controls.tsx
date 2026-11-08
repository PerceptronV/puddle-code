import type { Project } from '@puddle/shared';
import { Bot, Palette, Pencil, SquareTerminal } from 'lucide-react';
import { useState } from 'react';
import { ColourPicker } from '../../../../components/colour-picker';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '../../../../components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../../components/ui/dialog';
import {
  appearanceColourClass,
  appearanceColourStyle,
} from '../../../../lib/appearance/appearance-colours';
import { useDaemonVersion, usePatchProject } from '../../../../lib/queries/queries';
import { toastError } from '../../../../lib/transport/errors';
import {
  projectColourSupported,
  customProjectColourSupported,
} from '../../../../lib/transport/protocol-support';
import type { ProjectHeaderActions } from './types';
import { ProjectWindowMenu } from '../../../windows/menus/project-window-menu';

/**
 * A project-name drag reorders projects; its payload is this private MIME so no
 * pane or list mistakes it for a tab drag (reordering rides dragover, the
 * payload itself is never dropped anywhere).
 */
export const PROJECT_MIME = 'application/x-puddle-project';

/**
 * The project header's right-click menu: start a new agent or terminal IN that
 * project — the same create dialogue the sidebar's fixed controls open, seeded
 * with this project instead of the current one — and edit the label the header
 * is showing. `editLabel` names THAT label (the name in the expanded header, the
 * abbreviation on the collapsed rail) and opens the very editor a double-click
 * on it opens, so each menu offers exactly the field under the cursor.
 */
export function ProjectMenuBody({
  projectId,
  name,
  colour,
  actions,
  editLabel,
}: {
  projectId: string;
  name: string;
  colour: Project['colour'];
  actions: ProjectHeaderActions;
  editLabel: { label: string; onSelect: () => void };
}) {
  const [choosingColour, setChoosingColour] = useState(false);
  const patch = usePatchProject();
  const protocol = useDaemonVersion().data?.protocol;
  const colourSupported = projectColourSupported(protocol);
  const setColour = (next: string | null) =>
    patch.mutate(
      { id: projectId, colour: next },
      { onSuccess: () => setChoosingColour(false), onError: toastError },
    );
  return (
    <>
      <ContextMenuContent>
        <ProjectWindowMenu projectId={projectId} />
        <ContextMenuItem onSelect={() => actions.onNewSessionIn(projectId)}>
          <Bot />
          New agent
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onNewTerminalIn(projectId)}>
          <SquareTerminal />
          New terminal
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={editLabel.onSelect}>
          <Pencil />
          {editLabel.label}
        </ContextMenuItem>
        {colourSupported && (
          <ContextMenuItem onSelect={() => setChoosingColour(true)}>
            <Palette />
            Change project colour
          </ContextMenuItem>
        )}
      </ContextMenuContent>
      <Dialog open={choosingColour} onOpenChange={setChoosingColour}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Project colour</DialogTitle>
            <DialogDescription
              className={appearanceColourClass(colour)}
              style={appearanceColourStyle(colour)}
            >
              {name}
            </DialogDescription>
          </DialogHeader>
          <ColourPicker
            value={colour}
            label="Project colour"
            disabled={patch.isPending}
            onChange={setColour}
            onCustomChange={customProjectColourSupported(protocol) ? setColour : undefined}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
