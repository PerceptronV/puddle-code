import { Suspense, lazy } from 'react';
import type { TerminalProps } from './Terminal';

const Inner = lazy(() => import('./Terminal').then((module) => ({ default: module.Terminal })));

/** Code-split terminal: xterm loads in its own chunk on first use. */
export function LazyTerminal(props: TerminalProps) {
  return (
    <Suspense fallback={<div className="size-full bg-ground" />}>
      <Inner {...props} />
    </Suspense>
  );
}
