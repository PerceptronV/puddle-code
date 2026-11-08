import { useRef, useState, type PointerEvent, type MouseEvent, type RefObject } from 'react';
import type { HuddleDocument } from '@puddle/shared';
import { connectionProblem, type Endpoint } from '../../documents/graph-connections';
import type { Position } from '../geometry';

interface Pending {
  from: Endpoint;
  version: number;
  point?: Position;
}
interface Pointer {
  id: number;
  x: number;
  y: number;
  moved: boolean;
}

/** One transient gesture; only a successful drop/click edits the shared graph. */
export function useWireGesture({
  graph,
  version,
  locked,
  canvas,
  connect,
}: {
  graph: HuddleDocument;
  version: number;
  locked: boolean;
  canvas: RefObject<HTMLDivElement | null>;
  connect(from: Endpoint, to: Endpoint, version: number): boolean;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState('');
  const pointer = useRef<Pointer | null>(null);
  const skipClick = useRef(false);
  const current = !locked && pending?.version === version ? pending : null;
  const cancel = () => {
    setPending(null);
    pointer.current = null;
  };
  const finish = (to: Endpoint) => {
    if (!current) {
      cancel();
      return;
    }
    const problem = connectionProblem(graph, current.from, to);
    if (problem) {
      setPending({ ...current, point: undefined });
      setMessage(problem);
      return;
    }
    if (!connect(current.from, to, current.version)) {
      cancel();
      setMessage('Connection was not added. Choose the output again.');
      return;
    }
    setMessage(`Connected ${current.from.node}.${current.from.port} to ${to.node}.${to.port}.`);
    cancel();
  };
  const at = (event: PointerEvent): Position | undefined => {
    const element = canvas.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * element.offsetWidth) / rect.width,
      y: ((event.clientY - rect.top) * element.offsetHeight) / rect.height,
    };
  };
  return {
    pending: current,
    message: pending && !current ? 'Connection cancelled because the graph changed.' : message,
    cancel: () => {
      cancel();
      skipClick.current = true;
      setMessage('Connection cancelled.');
    },
    input(endpoint: Endpoint) {
      return {
        'data-huddle-input-node': endpoint.node,
        'data-huddle-input-port': endpoint.port,
        'aria-disabled': locked,
        onClick() {
          if (!locked) finish(endpoint);
        },
      };
    },
    output(endpoint: Endpoint) {
      return {
        'aria-pressed': current?.from.node === endpoint.node && current.from.port === endpoint.port,
        disabled: locked,
        onClick(event: MouseEvent<HTMLButtonElement>) {
          if (skipClick.current && event.detail !== 0) {
            skipClick.current = false;
            return;
          }
          setPending({ from: endpoint, version });
          setMessage(`Choose an input for ${endpoint.node}.${endpoint.port}. Escape cancels.`);
        },
        onPointerDown(event: PointerEvent<HTMLButtonElement>) {
          if (locked || event.button !== 0 || !event.isPrimary) return;
          event.stopPropagation();
          skipClick.current = false;
          event.currentTarget.setPointerCapture(event.pointerId);
          pointer.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            moved: false,
          };
          setPending({ from: endpoint, version });
          setMessage(`Choose an input for ${endpoint.node}.${endpoint.port}. Escape cancels.`);
        },
        onPointerMove(event: PointerEvent<HTMLButtonElement>) {
          const active = pointer.current;
          if (!active || active.id !== event.pointerId) return;
          if (!current) {
            cancel();
            skipClick.current = true;
            return;
          }
          if (!active.moved && Math.hypot(event.clientX - active.x, event.clientY - active.y) < 4)
            return;
          active.moved = true;
          setPending({ ...current, point: at(event) });
        },
        onPointerUp(event: PointerEvent<HTMLButtonElement>) {
          const active = pointer.current;
          if (!active || active.id !== event.pointerId) return;
          pointer.current = null;
          if (active.moved) {
            skipClick.current = true;
            const target = document
              .elementFromPoint(event.clientX, event.clientY)
              ?.closest<HTMLElement>('[data-huddle-input-node]');
            if (target && canvas.current?.contains(target))
              finish({
                node: target.dataset.huddleInputNode!,
                port: target.dataset.huddleInputPort!,
              });
            else {
              cancel();
              setMessage('Connection cancelled. Drop on an input socket.');
            }
          }
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        },
        onPointerCancel() {
          cancel();
          skipClick.current = true;
          setMessage('Connection cancelled.');
        },
        onLostPointerCapture() {
          if (pointer.current) {
            cancel();
            skipClick.current = true;
          }
        },
      };
    },
    problem(to: Endpoint) {
      return current ? connectionProblem(graph, current.from, to) : undefined;
    },
  };
}
export type WireGesture = ReturnType<typeof useWireGesture>;
