import type { HuddleComponent, HuddleNodeDefinition } from '@puddle/shared';
import { PuddleGlyph } from '../../../components/puddle-glyph';
import {
  appearanceColourClass,
  appearanceColourStyle,
} from '../../../lib/appearance/appearance-colours';
import { PROFILE_ICON_BY_NAME } from '../../profile/profile-icons';
import { cn } from '../../../lib/utils';
import { movePosition, type Position } from './geometry';
import type { useNodeDrag } from './use-node-drag';
import type { WireGesture } from './connections/use-wire-gesture';

export function NodeIsland({
  node,
  contract,
  position,
  shown,
  selected,
  locked,
  version,
  drag,
  wire,
  onSelect,
  move,
  undo,
  redo,
  onDelete,
}: {
  node: HuddleNodeDefinition;
  contract?: HuddleComponent;
  position: Position;
  shown: Position;
  selected: boolean;
  locked: boolean;
  version: number;
  drag: ReturnType<typeof useNodeDrag>;
  wire: WireGesture;
  onSelect(id: string): void;
  move(id: string, position: Position, version: number): boolean;
  undo(): void;
  redo(): void;
  onDelete(id: string): void;
}) {
  const inputs = Object.keys(contract?.inputs ?? {}),
    outputs = Object.keys(contract?.outputs ?? {});
  const appearance = node.appearance ?? contract?.appearance;
  const Icon = (appearance?.icon && PROFILE_ICON_BY_NAME[appearance.icon]) || PuddleGlyph;
  const portClass =
    'flex h-6 max-w-full items-center gap-2 rounded-sm text-xs hover:bg-explorer-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
  return (
    <div
      className={cn(
        'island-outline absolute w-60 select-none rounded-xl p-3',
        selected ? 'bg-elevated text-accent' : 'bg-surface text-fg',
      )}
      style={{ left: shown.x, top: shown.y }}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={[
          contract?.title ?? node.id,
          ...inputs,
          ...outputs,
          ...(!inputs.length && !outputs.length
            ? [contract?.category ?? 'Unresolved component']
            : []),
        ].join(' ')}
        onClick={() => onSelect(node.id)}
        {...drag.handlers(node.id, position)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            drag.cancel();
            return;
          }
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            if (event.shiftKey) redo();
            else undo();
            return;
          }
          if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            onDelete(node.id);
            return;
          }
          const delta = {
            ArrowLeft: [-1, 0],
            ArrowRight: [1, 0],
            ArrowUp: [0, -1],
            ArrowDown: [0, 1],
          }[event.key];
          if (!delta || locked) return;
          event.preventDefault();
          onSelect(node.id);
          const step = event.shiftKey ? 50 : 10;
          move(node.id, movePosition(position, delta[0]! * step, delta[1]! * step), version);
        }}
        className={cn(
          'mb-1 flex h-8 w-full touch-none items-center gap-2 rounded-md text-left text-sm transition-colors hover:bg-explorer-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          !locked && (drag.preview?.id === node.id ? 'cursor-grabbing' : 'cursor-grab'),
        )}
      >
        <span
          className={appearanceColourClass(appearance?.colour)}
          style={appearanceColourStyle(appearance?.colour)}
        >
          <Icon className="size-4" />
        </span>
        <span className="truncate">{contract?.title ?? node.id}</span>
      </button>
      <div className="flex justify-between gap-3 text-fg-muted">
        <div className="min-w-0">
          {inputs.map((port) => {
            const endpoint = { node: node.id, port };
            const problem = wire.problem(endpoint);
            return (
              <button
                type="button"
                key={port}
                aria-label={`Input ${node.id}.${port}`}
                title={
                  problem ??
                  `Input ${node.id}.${port}${contract?.inputs[port]?.scope === 'execution' ? ' · retained for this execution' : ''}`
                }
                aria-description={
                  contract?.inputs[port]?.scope === 'execution'
                    ? 'Retained for this execution, including feedback rounds'
                    : undefined
                }
                {...wire.input(endpoint)}
                className={cn(
                  portClass,
                  wire.pending && !problem && 'text-accent',
                  wire.pending && problem && 'opacity-50',
                )}
              >
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
                <span className="truncate">{port}</span>
              </button>
            );
          })}
        </div>
        <div className="min-w-0">
          {outputs.map((port) => (
            <button
              type="button"
              key={port}
              aria-label={`Output ${node.id}.${port}`}
              {...wire.output({ node: node.id, port })}
              className={cn(portClass, 'ml-auto touch-none justify-end disabled:opacity-50')}
            >
              <span className="truncate">{port}</span>
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
            </button>
          ))}
        </div>
      </div>
      {!inputs.length && !outputs.length && (
        <span className="text-xs text-fg-muted">
          {contract?.category ?? 'Unresolved component'}
        </span>
      )}
    </div>
  );
}
