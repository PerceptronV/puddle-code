import { Suspense, lazy, type ComponentType } from 'react';
import type { TerminalProps } from './Terminal';

const Inner = lazy(() => import('./Terminal').then((module) => ({ default: module.Terminal })));

// Set once the chunk is warmed: from then on the terminal renders DIRECTLY,
// with no Suspense pass at all. The workspace warms this before mounting a
// restored layout — a reload must never suspend the whole tiling tree into
// blank fallbacks (the reveal only reached the screen on the next render).
let Ready: ComponentType<TerminalProps> | null = null;

/** Load the xterm chunk ahead of mounting (the workspace's restore gate). */
export async function warmTerminalChunk(): Promise<void> {
  const module = await import('./Terminal');
  Ready = module.Terminal;
}

/** Code-split terminal: xterm loads in its own chunk on first use. */
export function LazyTerminal(props: TerminalProps) {
  if (Ready) return <Ready {...props} />;
  return (
    <Suspense fallback={<div className="size-full bg-ground" />}>
      <Inner {...props} />
    </Suspense>
  );
}
