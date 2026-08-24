import { useRef } from 'react';
import { useCustomCursor } from './use-custom-cursor';

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

export function DraftingCursor() {
  const ref = useRef<HTMLDivElement>(null);
  useCustomCursor(ref);

  return (
    <div ref={ref} className="custom-cursor drafting-cursor" aria-hidden="true">
      {SIDES.map((side) => (
        <span key={side} className="drafting-cursor-tick" data-side={side} />
      ))}
    </div>
  );
}
