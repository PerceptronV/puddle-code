import { useState, useRef, useLayoutEffect } from 'react';
import type { HuddleDocument } from '@puddle/shared';
import { PuddleGlyph } from '../../../components/puddle-glyph';
import { CanvasControls } from './CanvasControls';
import {
  appearanceColourClass,
  appearanceColourStyle,
} from '../../../lib/appearance/appearance-colours';
import { PROFILE_ICON_BY_NAME } from '../../profile/profile-icons';
import { cn } from '../../../lib/utils';
import { defaultPosition, movePosition, type Position } from './geometry';
import { useNodeDrag } from './use-node-drag';

/** Interactive node islands; persisted positions live in the shared layout source buffer. */
export function GraphOverview({
  document,
  selected,
  onSelect,
  move,
  version,
  locked,
  undo,
  redo,
  canUndo,
  canRedo,
  onDelete,
}: {
  document: HuddleDocument;
  selected: string | null;
  onSelect(id: string): void;
  move(id: string, position: Position, version: number): boolean;
  version: number;
  locked: boolean;
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
  onDelete(id: string): void;
}) {
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  const pan = useRef<{ pointer: number; x: number; y: number; left: number; top: number } | null>(
    null,
  );
  const drag = useNodeDrag({ viewport, zoom, version, locked, move, select: onSelect });
  const nodes = document.definition.nodes.map((node, index) => {
    const contract = document.components[node.id];
    return {
      node,
      contract,
      position: document.layout?.nodes[node.id] ?? defaultPosition(index),
      inputs: Object.keys(contract?.inputs ?? {}),
      outputs: Object.keys(contract?.outputs ?? {}),
    };
  });
  const left = Math.min(0, ...nodes.map(({ position }) => position.x)) - 32;
  const top = Math.min(0, ...nodes.map(({ position }) => position.y)) - 32;
  const previousOrigin = useRef({ left, top, zoom });
  useLayoutEffect(() => {
    const previous = previousOrigin.current;
    const view = viewport.current;
    if (view && zoom === previous.zoom) {
      view.scrollLeft += (previous.left - left) * zoom;
      view.scrollTop += (previous.top - top) * zoom;
    }
    previousOrigin.current = { left, top, zoom };
  }, [left, top, zoom]);
  const width = Math.max(640, ...nodes.map(({ position }) => position.x - left + 272));
  const height = Math.max(
    400,
    ...nodes.map(
      ({ position, inputs, outputs }) =>
        position.y - top + 90 + Math.max(inputs.length, outputs.length) * 24,
    ),
  );
  const byId = new Map(nodes.map((node) => [node.node.id, node]));
  const displayPosition = (id: string, position: Position) =>
    drag.preview?.id === id ? drag.preview.position : position;
  const fit = (selection: boolean) => {
    const view = viewport.current;
    const targets = nodes.filter((item) => !selection || item.node.id === selected);
    if (!view || !targets.length) return;
    const x = Math.min(...targets.map((item) => item.position.x)),
      y = Math.min(...targets.map((item) => item.position.y));
    const right = Math.max(...targets.map((item) => item.position.x + 240));
    const bottom = Math.max(
      ...targets.map(
        (item) => item.position.y + 90 + 24 * Math.max(item.inputs.length, item.outputs.length),
      ),
    );
    const next = Math.min(
      2,
      Math.max(
        0.001,
        Math.min((view.clientWidth - 64) / (right - x), (view.clientHeight - 64) / (bottom - y)),
      ),
    );
    setZoom(next);
    requestAnimationFrame(() => {
      view.scrollLeft = (x - left) * next - (view.clientWidth - (right - x) * next) / 2;
      view.scrollTop = (y - top) * next - (view.clientHeight - (bottom - y) * next) / 2;
    });
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <CanvasControls {...{ locked, canUndo, canRedo, undo, redo, selected, fit, zoom, setZoom }} />
      <div
        ref={viewport}
        className="min-h-0 flex-1 cursor-grab overflow-auto touch-none"
        aria-label="Huddle graph"
        tabIndex={0}
        onPointerDown={(event) => {
          if (
            ![0, 1].includes(event.button) ||
            !event.isPrimary ||
            (event.target as HTMLElement).closest('button')
          )
            return;
          event.preventDefault();
          event.currentTarget.style.cursor = 'grabbing';
          event.currentTarget.setPointerCapture(event.pointerId);
          pan.current = {
            pointer: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: event.currentTarget.scrollLeft,
            top: event.currentTarget.scrollTop,
          };
        }}
        onPointerMove={(event) => {
          const start = pan.current;
          if (!start || start.pointer !== event.pointerId) return;
          event.currentTarget.scrollLeft = start.left - event.clientX + start.x;
          event.currentTarget.scrollTop = start.top - event.clientY + start.y;
        }}
        onPointerUp={(event) => {
          pan.current = null;
          event.currentTarget.style.cursor = '';
        }}
        onPointerCancel={(event) => {
          pan.current = null;
          event.currentTarget.style.cursor = '';
        }}
        onLostPointerCapture={(event) => {
          pan.current = null;
          event.currentTarget.style.cursor = '';
        }}
      >
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
                const fromPosition = displayPosition(from.node.id, from.position),
                  toPosition = displayPosition(to.node.id, to.position);
                const x = fromPosition.x - left + 240,
                  y =
                    fromPosition.y -
                    top +
                    61 +
                    Math.max(0, from.outputs.indexOf(edge.from.port)) * 24;
                const tx = toPosition.x - left,
                  ty = toPosition.y - top + 61 + Math.max(0, to.inputs.indexOf(edge.to.port)) * 24;
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
              const shown = displayPosition(node.id, position);
              return (
                <button
                  type="button"
                  key={node.id}
                  aria-pressed={selected === node.id}
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
                    move(
                      node.id,
                      movePosition(position, delta[0]! * step, delta[1]! * step),
                      version,
                    );
                  }}
                  className={cn(
                    'island-outline absolute w-60 touch-none select-none rounded-xl p-3 text-left transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    !locked && (drag.preview?.id === node.id ? 'cursor-grabbing' : 'cursor-grab'),
                    selected === node.id ? 'bg-elevated text-accent' : 'bg-surface text-fg',
                  )}
                  style={{ left: shown.x - left, top: shown.y - top }}
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
