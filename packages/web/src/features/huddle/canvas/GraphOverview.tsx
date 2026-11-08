import { useState } from 'react';
import type { HuddleDocument } from '@puddle/shared';
import { PuddleGlyph } from '../../../components/puddle-glyph';
import { ControlTray } from '../../../components/ui/control-tray';
import {
  appearanceColourClass,
  appearanceColourStyle,
} from '../../../lib/appearance/appearance-colours';
import { PROFILE_ICON_BY_NAME } from '../../profile/profile-icons';
import { cn } from '../../../lib/utils';

/** Inspectable graph geometry. Graph/source editing shares the document revision in the next layer. */
export function GraphOverview({
  document,
  selected,
  onSelect,
}: {
  document: HuddleDocument;
  selected: string | null;
  onSelect(id: string): void;
}) {
  const [zoom, setZoom] = useState(1);
  const nodes = document.definition.nodes.map((node, index) => {
    const contract = document.components[node.id];
    return {
      node,
      contract,
      position: document.layout?.nodes[node.id] ?? {
        x: (index % 3) * 320,
        y: Math.floor(index / 3) * 220,
      },
      inputs: Object.keys(contract?.inputs ?? {}),
      outputs: Object.keys(contract?.outputs ?? {}),
    };
  });
  const left = Math.min(0, ...nodes.map(({ position }) => position.x)) - 32;
  const top = Math.min(0, ...nodes.map(({ position }) => position.y)) - 32;
  const width = Math.max(640, ...nodes.map(({ position }) => position.x - left + 272));
  const height = Math.max(
    400,
    ...nodes.map(
      ({ position, inputs, outputs }) =>
        position.y - top + 90 + Math.max(inputs.length, outputs.length) * 24,
    ),
  );
  const byId = new Map(nodes.map((node) => [node.node.id, node]));
  return (
    <div className="relative min-h-0 flex-1">
      <div className="absolute right-3 top-2 z-10">
        <ControlTray label="Graph zoom" variant="island">
          <button
            type="button"
            className="rounded-md px-2 py-1 text-sm hover:bg-elevated"
            aria-label="Zoom out"
            onClick={() => setZoom(Math.max(0.25, zoom - 0.25))}
          >
            −
          </button>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs hover:bg-elevated"
            aria-label="Reset zoom"
            onClick={() => setZoom(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-sm hover:bg-elevated"
            aria-label="Zoom in"
            onClick={() => setZoom(Math.min(2, zoom + 0.25))}
          >
            +
          </button>
        </ControlTray>
      </div>
      <div className="size-full overflow-auto" aria-label="Huddle graph" tabIndex={0}>
        <div style={{ width: width * zoom, height: height * zoom }}>
          <div
            className="relative origin-top-left"
            style={{ width, height, transform: `scale(${zoom})` }}
          >
            <svg
              className="pointer-events-none absolute inset-0 text-fg-muted"
              width={width}
              height={height}
              aria-hidden="true"
            >
              {document.definition.edges.map((edge) => {
                const from = byId.get(edge.from.node);
                const to = byId.get(edge.to.node);
                if (!from || !to) return null;
                const x = from.position.x - left + 240,
                  y =
                    from.position.y -
                    top +
                    61 +
                    Math.max(0, from.outputs.indexOf(edge.from.port)) * 24;
                const tx = to.position.x - left,
                  ty = to.position.y - top + 61 + Math.max(0, to.inputs.indexOf(edge.to.port)) * 24;
                return (
                  <path
                    key={edge.id}
                    d={`M ${x} ${y} C ${x + 80} ${y}, ${tx - 80} ${ty}, ${tx} ${ty}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeDasharray={edge.feedback ? '5 4' : undefined}
                  />
                );
              })}
            </svg>
            {nodes.map(({ node, contract, position, inputs, outputs }) => {
              const appearance = node.appearance ?? contract?.appearance;
              const Icon =
                (appearance?.icon && PROFILE_ICON_BY_NAME[appearance.icon]) || PuddleGlyph;
              return (
                <button
                  type="button"
                  key={node.id}
                  aria-pressed={selected === node.id}
                  onClick={() => onSelect(node.id)}
                  className={cn(
                    'island-outline absolute w-60 rounded-xl p-3 text-left transition-colors hover:bg-elevated',
                    selected === node.id ? 'bg-elevated text-accent' : 'bg-surface text-fg',
                  )}
                  style={{ left: position.x - left, top: position.y - top }}
                >
                  <span className="mb-3 flex items-center gap-2">
                    <span
                      className={appearanceColourClass(appearance?.colour)}
                      style={appearanceColourStyle(appearance?.colour)}
                    >
                      <Icon className="size-4" />
                    </span>
                    <span className="truncate text-sm">{contract?.title ?? node.id}</span>
                  </span>
                  <span className="flex justify-between gap-3 text-xs text-fg-muted">
                    <span>
                      {inputs.map((port) => (
                        <span key={port} className="flex h-6 items-center gap-2">
                          <span aria-hidden className="size-1.5 rounded-full bg-current" />
                          {port}
                        </span>
                      ))}
                    </span>
                    <span>
                      {outputs.map((port) => (
                        <span key={port} className="flex h-6 items-center justify-end gap-2">
                          {port}
                          <span aria-hidden className="size-1.5 rounded-full bg-current" />
                        </span>
                      ))}
                    </span>
                  </span>
                  {!inputs.length && !outputs.length && (
                    <span className="text-xs text-fg-muted">
                      {contract?.category ?? 'Unresolved component'}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
