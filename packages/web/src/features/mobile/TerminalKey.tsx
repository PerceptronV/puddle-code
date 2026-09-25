import { useRef, type ComponentProps } from 'react';
import { Button } from '../../components/ui/button';

/** Activate on touchend, before Safari can blur the input or synthesise a second click. */
export function TerminalKey({
  activate,
  ...props
}: Omit<ComponentProps<typeof Button>, 'onClick'> & { activate(): void }) {
  const touch = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const lastTouch = useRef(-Infinity);
  return (
    <Button
      {...props}
      onPointerDown={(event) => {
        event.preventDefault();
        // A real mouse/pen press is a new activation, even just after a touch.
        if (event.pointerType !== 'touch') lastTouch.current = -Infinity;
      }}
      onTouchStart={(event) => {
        const first = event.touches[0];
        touch.current =
          first && event.touches.length === 1
            ? { x: first.clientX, y: first.clientY, moved: false }
            : null;
      }}
      onTouchMove={(event) => {
        const first = event.touches[0];
        if (
          touch.current &&
          (!first ||
            event.touches.length !== 1 ||
            Math.hypot(first.clientX - touch.current.x, first.clientY - touch.current.y) > 8)
        )
          touch.current.moved = true;
      }}
      onTouchCancel={() => {
        touch.current = null;
      }}
      onTouchEnd={(event) => {
        const tap = touch.current;
        touch.current = null;
        if (!tap || tap.moved || props.disabled) return;
        event.preventDefault();
        lastTouch.current = performance.now();
        activate();
      }}
      onClick={(event) => {
        if (event.detail !== 0 && performance.now() - lastTouch.current < 700) return;
        activate();
      }}
    />
  );
}
