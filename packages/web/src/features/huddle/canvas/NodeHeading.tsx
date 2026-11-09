import { useLayoutEffect, useRef, useState, type KeyboardEventHandler } from 'react';
import { toast } from 'sonner';
import { PuddleGlyph } from '../../../components/puddle-glyph';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { Input } from '../../../components/ui/input';
import { NODE_ICON_BY_NAME } from '../appearance/node-icons';
import { NodeIconChoices } from '../controls/NodeIconChoices';

export function NodeHeading({
  title,
  label,
  icon,
  selected,
  canRename,
  locked,
  rename,
  changeIcon,
  onKeyDown,
}: {
  title: string;
  label: string;
  icon?: string | null;
  selected: boolean;
  canRename: boolean;
  locked: boolean;
  rename(name: string): void;
  changeIcon(icon: string | null): void;
  onKeyDown: KeyboardEventHandler<HTMLButtonElement>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [iconsOpen, setIconsOpen] = useState(false);
  const editing = useRef(false);
  const header = useRef<HTMLDivElement>(null);
  const wasEditing = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const isEditing = draft !== null;
  useLayoutEffect(() => {
    if (isEditing) {
      const input = header.current?.querySelector('input');
      input?.focus({ preventScroll: true });
      input?.select();
    } else if (wasEditing.current) button.current?.focus({ preventScroll: true });
    wasEditing.current = isEditing;
  }, [isEditing]);
  const commit = () => {
    if (!editing.current) return;
    editing.current = false;
    if (draft !== null && draft.trim() !== title) rename(draft);
    setDraft(null);
  };
  const Icon = (icon && NODE_ICON_BY_NAME[icon]) || PuddleGlyph;
  return (
    <div ref={header} className="mb-1 flex h-8 items-center gap-2" data-node-identity>
      <Popover open={iconsOpen} onOpenChange={setIconsOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Change icon for ${title}`}
            disabled={locked}
            className="flex size-7 shrink-0 cursor-grab items-center justify-center rounded-md hover:bg-explorer-hover disabled:opacity-50"
          >
            <Icon className="size-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80" onPointerDown={(event) => event.stopPropagation()}>
          <NodeIconChoices
            value={icon}
            onSelect={(next) => {
              changeIcon(next);
              setIconsOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      {isEditing ? (
        <Input
          aria-label="Node name"
          data-node-control
          maxLength={200}
          className="h-8 min-w-0 flex-1"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              editing.current = false;
              setDraft(null);
            }
          }}
        />
      ) : (
        <button
          ref={button}
          type="button"
          data-node-name
          aria-label={label}
          aria-pressed={selected}
          title="Rename node"
          onKeyDown={onKeyDown}
          className="flex h-8 min-w-0 flex-1 cursor-grab touch-none items-center rounded-md text-left text-sm transition-colors hover:bg-explorer-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => {
            if (!canRename) {
              toast.warning('Node renaming requires a supporting host and an editable layout.');
              return;
            }
            editing.current = true;
            setDraft(title);
          }}
        >
          <span className="truncate">{title}</span>
        </button>
      )}
    </div>
  );
}
