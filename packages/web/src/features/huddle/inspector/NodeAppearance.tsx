import { useState } from 'react';
import type { HuddleComponent, HuddleNodeDefinition } from '@puddle/shared';
import { ColourPicker } from '../../../components/colour-picker';
import { PuddleGlyph } from '../../../components/puddle-glyph';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { PROFILE_ICONS, PROFILE_ICON_BY_NAME } from '../../profile/profile-icons';
import { graphActionClass, type EditGraph } from './GraphEditing';

export function NodeAppearance({
  node,
  component,
  edit,
}: {
  node: HuddleNodeDefinition;
  component?: HuddleComponent;
  edit: EditGraph;
}) {
  const [open, setOpen] = useState(false);
  const appearance = node.appearance ?? component?.appearance ?? { icon: null, colour: null };
  const Icon = (appearance.icon && PROFILE_ICON_BY_NAME[appearance.icon]) || PuddleGlyph;
  const update = (patch: Partial<NonNullable<HuddleNodeDefinition['appearance']>>) =>
    edit((definition) => ({
      ...definition,
      nodes: definition.nodes.map((item) =>
        item.id === node.id
          ? {
              ...item,
              appearance: {
                ...(item.appearance ?? component?.appearance ?? { icon: null, colour: null }),
                ...patch,
              },
            }
          : item,
      ),
    }));
  return (
    <div className="flex flex-col gap-3">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={`${graphActionClass} flex items-center gap-2`}>
            <Icon className="size-4" />
            Choose node icon
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72">
          <div className="grid grid-cols-8 gap-1" aria-label="Node icons">
            <button
              type="button"
              aria-label="Default node icon"
              className={graphActionClass}
              onClick={() => {
                update({ icon: null });
                setOpen(false);
              }}
            >
              <PuddleGlyph className="size-4" />
            </button>
            {PROFILE_ICONS.map(({ name, Icon: Choice }) => (
              <button
                type="button"
                key={name}
                title={name}
                aria-label={name}
                aria-pressed={appearance.icon === name}
                className={`${graphActionClass} flex h-8 items-center justify-center`}
                onClick={() => {
                  update({ icon: name });
                  setOpen(false);
                }}
              >
                <Choice className="size-4" />
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <ColourPicker
        label="Node colour"
        value={appearance.colour}
        onChange={(colour) => update({ colour })}
        onCustomChange={(colour) => update({ colour })}
      />
    </div>
  );
}
