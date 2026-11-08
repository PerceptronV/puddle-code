import type { HuddleEdge } from '@puddle/shared';
import type { Endpoint } from '../../documents/graph-connections';
import { WIRE_BEND, type Position } from '../geometry';
import type { WireGesture } from './use-wire-gesture';
import type { HuddleBounds } from '../../view/camera';
import { intersects, wireBounds } from '../visibility/bounds';

function curve(from: Position, to: Position) {
  return `M ${from.x} ${from.y} C ${from.x + WIRE_BEND} ${from.y}, ${to.x - WIRE_BEND} ${to.y}, ${to.x} ${to.y}`;
}
export function WireLayer({
  edges,
  width,
  height,
  socket,
  selected,
  select,
  locked,
  disconnect,
  wire,
  visible,
  focused,
}: {
  visible: HuddleBounds | null;
  focused?: string;
  edges: HuddleEdge[];
  width: number;
  height: number;
  socket(endpoint: Endpoint, direction: 'inputs' | 'outputs'): Position | undefined;
  selected: string | null;
  select(id: string): void;
  locked: boolean;
  disconnect(id: string): void;
  wire: WireGesture;
}) {
  const preview = wire.pending && socket(wire.pending.from, 'outputs');
  return (
    <svg
      className="pointer-events-none absolute inset-0 text-fg-muted"
      width={width}
      height={height}
    >
      {edges.map((edge) => {
        const from = socket(edge.from, 'outputs'),
          to = socket(edge.to, 'inputs');
        if (!from || !to) return null;
        if (
          edge.id !== selected &&
          edge.id !== focused &&
          !intersects(wireBounds(from, to), visible)
        )
          return null;
        const path = curve(from, to);
        return (
          <g key={edge.id} data-huddle-edge={edge.id}>
            <path
              d={path}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              aria-hidden
              className={selected === edge.id ? 'text-accent' : undefined}
              strokeDasharray={edge.feedback ? '5 4' : undefined}
            />
            <path
              d={path}
              fill="none"
              stroke="transparent"
              strokeWidth={14}
              vectorEffect="non-scaling-stroke"
              className="pointer-events-auto cursor-pointer hover:stroke-accent/30 focus-visible:stroke-accent/30 focus-visible:outline-none"
              role="button"
              tabIndex={0}
              aria-pressed={selected === edge.id}
              aria-label={`Connection ${edge.from.node}.${edge.from.port} to ${edge.to.node}.${edge.to.port}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => {
                if (wire.pending) wire.cancel();
                select(edge.id);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  select(edge.id);
                }
                if ((event.key === 'Delete' || event.key === 'Backspace') && !locked) {
                  event.preventDefault();
                  disconnect(edge.id);
                }
              }}
            >
              <title>Select connection; Delete disconnects</title>
            </path>
          </g>
        );
      })}
      {preview && wire.pending?.point && (
        <path
          d={curve(preview, wire.pending.point)}
          fill="none"
          stroke="currentColor"
          aria-hidden
          strokeWidth={1.5}
          strokeDasharray="5 4"
          className="text-accent"
        />
      )}
    </svg>
  );
}
