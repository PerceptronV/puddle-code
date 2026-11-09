import { NodeIconChoices } from '../controls/NodeIconChoices';
import { useState } from 'react';
import type { HuddleComponent, HuddleNodeDefinition } from '@puddle/shared';
import { ColourPicker } from '../../../components/colour-picker';
import { PuddleGlyph } from '../../../components/puddle-glyph';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { NODE_ICON_BY_NAME } from '../appearance/node-icons';
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
  const Icon = (appearance.icon && NODE_ICON_BY_NAME[appearance.icon]) || PuddleGlyph;
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
        <PopoverContent className="w-80">
          <NodeIconChoices
            value={appearance.icon}
            onSelect={(icon) => {
              update({ icon });
              setOpen(false);
            }}
          />
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
