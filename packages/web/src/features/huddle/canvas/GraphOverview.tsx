import { useCanvasGestures } from './use-canvas-gestures';
import { useState, useRef, useLayoutEffect } from 'react';
import type { HuddleDocument } from '@puddle/shared';
import { CanvasControls } from './CanvasControls';
import { WireLayer } from './connections/WireLayer';
import { NodeIsland } from './NodeIsland';
import { useWireGesture } from './connections/use-wire-gesture';
import type { Endpoint } from '../documents/graph-connections';
import { defaultPosition, type Position } from './geometry';
import { useNodeDrag } from './use-node-drag';
import { bindHuddleCamera, type HuddleCameraBinding } from '../view/camera';
import type { HuddleCamera } from '../view/state';
import { useGraphViewport } from './visibility/use-viewport';
import { useCanvasFocus } from './visibility/use-canvas-focus';
import { intersects, nodeBounds } from './visibility/bounds';

/** Interactive node islands; persisted positions live in the shared layout source buffer. */
export function GraphOverview({
  document,
  selected,
  onSelect,
  rename,
  changeIcon,
  canRename,
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
  camera,
  rememberCamera,
  selectedEdge,
  setSelectedEdge,
}: {
  camera: HuddleCamera | null;
  rememberCamera(camera: HuddleCamera): void;
  selectedEdge: string | null;
  setSelectedEdge(id: string | null): void;
  document: HuddleDocument;
  selected: string | null;
  onSelect(id: string): void;
  rename(id: string, name: string): void;
  changeIcon(id: string, icon: string | null): void;
  canRename: boolean;
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
  const [initialCamera] = useState(camera);
  const [zoom, setZoom] = useState(camera?.zoom ?? 1);
  const cameraBinding = useRef<HuddleCameraBinding | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const focus = useCanvasFocus();
  const wire = useWireGesture({
    graph: document,
    version: graphVersion,
    locked: graphLocked,
    canvas,
    connect,
  });
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useNodeDrag({ viewport, zoom, version, locked, move, select: onSelect });
  const gestures = useCanvasGestures(viewport, cameraBinding, () => {
    drag.cancel();
    if (wire.pending) wire.cancel();
  });
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
  const padding = 1600 / zoom;
  const origin = {
    x: Math.min(0, ...nodes.map(({ position }) => position.x)) - 32,
    y: Math.min(0, ...nodes.map(({ position }) => position.y)) - 32,
  };
  const left = origin.x - padding;
  const top = origin.y - padding;
  const width = Math.max(640, ...nodes.map(({ position }) => position.x - left + 272 + padding));
  const height = Math.max(
    400,
    ...nodes.map(
      ({ position, inputs, outputs }) =>
        position.y - top + padding + 90 + Math.max(inputs.length, outputs.length) * 24,
    ),
  );
  const [initialGeometry] = useState({ left, top, width, height });
  useLayoutEffect(() => {
    const binding = bindHuddleCamera(
      viewport.current!,
      initialGeometry,
      initialCamera ?? { x: initialGeometry.left + 1600, y: initialGeometry.top + 1600, zoom: 1 },
      rememberCamera,
      setZoom,
    );
    cameraBinding.current = binding;
    return () => {
      binding.dispose();
      cameraBinding.current = null;
    };
  }, [initialCamera, initialGeometry, rememberCamera]);
  useLayoutEffect(() => {
    cameraBinding.current?.geometry({ left, top, width, height });
  }, [left, top, width, height, zoom]);
  const visible = useGraphViewport(viewport, zoom, { left, top, width, height });
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
    cameraBinding.current?.fit({ x, y, right, bottom });
  };
  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onKeyDown={(event) => {
        if (event.key === 'Escape') wire.cancel();
      }}
    >
      <CanvasControls
        {...{ locked, canUndo, canRedo, undo, redo, selected, fit, zoom }}
        setZoom={(value) => cameraBinding.current?.zoom(value)}
      />
      {(selectedEdge || wire.message || wire.pending) && (
        <div className="island-outline absolute left-3 top-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-2 rounded-[var(--ui-surface-radius)] bg-tray px-3 py-2 text-xs text-fg-muted">
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
      )}
      <div
        ref={viewport}
        className="no-scrollbar min-h-0 flex-1 cursor-grab overflow-hidden touch-none overscroll-none [overflow-anchor:none]"
        aria-label="Huddle graph"
        aria-description="Only nearby nodes and connections are drawn. Use Node list to browse all nodes, then Fit selected to reveal one."
        tabIndex={0}
        {...gestures}
      >
        <div style={{ width: width * zoom, height: height * zoom }}>
          <div
            ref={canvas}
            {...focus.handlers}
            className="relative origin-top-left"
            style={{ width, height, transform: `scale(${zoom})` }}
          >
            <WireLayer
              edges={document.definition.edges}
              {...{ width, height, wire, visible }}
              focused={focus.focused.edge}
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
            {nodes.map(({ node, contract, position, inputs, outputs }) => {
              const shown = displayPosition(node.id, position);
              const local = { x: shown.x - left, y: shown.y - top };
              if (
                node.id !== selected &&
                node.id !== focus.focused.node &&
                node.id !== drag.preview?.id &&
                node.id !== wire.pending?.from.node &&
                !intersects(nodeBounds(local, inputs.length, outputs.length), visible)
              )
                return null;
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
                  title={document.layout?.labels?.[node.id] ?? contract?.title ?? node.id}
                  rename={(name) => rename(node.id, name)}
                  changeIcon={(icon) => changeIcon(node.id, icon)}
                  canRename={canRename}
                  selected={selected === node.id}
                  shown={local}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
