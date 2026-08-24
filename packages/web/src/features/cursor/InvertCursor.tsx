import { useRef } from 'react';
import { useCustomCursor } from './use-custom-cursor';

export function InvertCursor() {
  const ref = useRef<HTMLDivElement>(null);
  useCustomCursor(ref);
  return <div ref={ref} className="custom-cursor invert-cursor" aria-hidden="true" />;
}
