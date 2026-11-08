import { useState, useRef, useLayoutEffect } from 'react';
import type { HuddleDocument } from '@puddle/shared';
import { CanvasControls } from './CanvasControls';
import { WireLayer } from './connections/WireLayer';
import { NodeIsland } from './NodeIsland';
import { useWireGesture } from './connections/use-wire-gesture';
import type { Endpoint } from '../documents/graph-connections';
import { defaultPosition, type Position } from './geometry';
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
  connect,
  graphVersion,
  graphLocked,
  disconnect,
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
  connect(from: Endpoint, to: Endpoint, version: number): boolean;
  graphVersion: number;
  graphLocked: boolean;
  disconnect(id: string): void;
}) {
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const canvas = useRef<HTMLDivElement>(null);
  const wire = useWireGesture({
    graph: document,
    version: graphVersion,
    locked: graphLocked,
    canvas,
    connect,
  });
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
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.key === 'Escape') wire.cancel();
      }}
    >
      <CanvasControls {...{ locked, canUndo, canRedo, undo, redo, selected, fit, zoom, setZoom }} />
      <div className="flex min-h-5 items-center gap-2 px-3 text-xs text-fg-muted">
        {document.definition.edges.some((edge) => edge.id === selectedEdge) && (
          <button
            type="button"
            disabled={graphLocked}
            className="rounded px-2 hover:bg-elevated disabled:opacity-50"
            onClick={() => {
              disconnect(selectedEdge!);
              setSelectedEdge(null);
            }}
          >
            Disconnect selected
          </button>
        )}
        <span role="status">{wire.message}</span>
        {wire.pending && (
          <button type="button" className="rounded px-2 hover:bg-elevated" onClick={wire.cancel}>
            Cancel connection
          </button>
        )}
      </div>
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
            ref={canvas}
            className="relative origin-top-left"
            style={{ width, height, transform: `scale(${zoom})` }}
          >
            <WireLayer
              edges={document.definition.edges}
              {...{ width, height, wire }}
              selected={selectedEdge}
              select={setSelectedEdge}
              locked={graphLocked}
              disconnect={(id) => {
                disconnect(id);
                setSelectedEdge(null);
              }}
              socket={(endpoint, direction) => {
                const item = byId.get(endpoint.node);
                if (!item) return;
                const position = displayPosition(endpoint.node, item.position);
                return {
                  x: position.x - left + (direction === 'outputs' ? 225 : 15),
                  y:
                    position.y -
                    top +
                    60 +
                    Math.max(0, item[direction].indexOf(endpoint.port)) * 24,
                };
              }}
            />
            {nodes.map(({ node, contract, position }) => {
              const shown = displayPosition(node.id, position);
              return (
                <NodeIsland
                  key={node.id}
                  {...{
                    node,
                    contract,
                    position,
                    locked,
                    version,
                    drag,
                    wire,
                    onSelect,
                    move,
                    undo,
                    redo,
                    onDelete,
                  }}
                  selected={selected === node.id}
                  shown={{ x: shown.x - left, y: shown.y - top }}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
