import { useRef, useState, type HTMLAttributes, type SyntheticEvent } from 'react';
import './inline-math-toggle.css';

/** Shared direct interaction for inline maths; dragging still selects browser text. */
export function useInlineMathToggle(source: string, enabled: boolean) {
  const [choice, setChoice] = useState<{ source: string; visible: boolean } | null>(null);
  const pointer = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const sourceVisible = choice?.source === source && choice.visible;
  const toggle = () => {
    if (enabled) setChoice({ source, visible: !sourceVisible });
  };
  const isolateNativeMouse = (event: SyntheticEvent<HTMLElement>) => {
    if (event.currentTarget.closest('.xterm')) event.stopPropagation();
  };
  const props: HTMLAttributes<HTMLElement> = {
    role: 'button',
    tabIndex: 0,
    'aria-label': sourceVisible ? 'Show LaTeX preview' : 'Show LaTeX source',
    'aria-pressed': sourceVisible,
    'aria-disabled': !enabled,
    onPointerDown: (event) => {
      isolateNativeMouse(event);
      pointer.current = { x: event.clientX, y: event.clientY, dragged: false };
    },
    onPointerMove: (event) => {
      isolateNativeMouse(event);
      if (
        pointer.current &&
        event.buttons &&
        Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 4
      )
        pointer.current.dragged = true;
    },
    onMouseMove: isolateNativeMouse,
    onMouseDown: isolateNativeMouse,
    onMouseUp: isolateNativeMouse,
    onClick: (event) => {
      event.stopPropagation();
      if (pointer.current?.dragged || !window.getSelection()?.isCollapsed) return;
      toggle();
    },
    onKeyDown: (event) => {
      event.stopPropagation();
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    },
    onKeyUp: (event) => event.stopPropagation(),
  };
  return { sourceVisible, props };
}
