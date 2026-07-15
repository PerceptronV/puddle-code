import { Suspense, lazy } from 'react';
import type { RevealTarget } from '../workspace/editor-context';
import type { EditorTab, EditorTabKind } from './editor-tabs';
import type { HeldBuffer } from './ModelRefcount';

/**
 * Lazy wrappers for the tiling layout's Monaco-touching pieces (SPEC §8), so the
 * eager `TileTree`/`PaneLeaf`/`PaneTabStrip` chrome never pulls `buffer-store`
 * (→ Monaco) onto the startup bundle — a terminal-only workspace loads no editor
 * code. Each mirrors `LazyEditorPane`/`LazyTerminal`.
 */

const BodyInner = lazy(() =>
  import('./PaneEditorBody').then((m) => ({ default: m.PaneEditorBody })),
);
export function LazyPaneEditorBody(props: { tab: EditorTab; reveal: RevealTarget | null }) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center bg-ground text-xs text-fg-muted">
          Loading editor…
        </div>
      }
    >
      <BodyInner {...props} />
    </Suspense>
  );
}

const RefcountInner = lazy(() =>
  import('./ModelRefcount').then((m) => ({ default: m.ModelRefcount })),
);
export function LazyModelRefcount({ buffers }: { buffers: HeldBuffer[] }) {
  return (
    <Suspense fallback={null}>
      <RefcountInner buffers={buffers} />
    </Suspense>
  );
}

const CloseInner = lazy(() =>
  import('./EditorTabClose').then((m) => ({ default: m.EditorTabClose })),
);
export function LazyEditorTabClose(props: {
  session: string;
  path: string;
  kind: EditorTabKind;
  label: string;
  onClose: () => void;
}) {
  // Fallback: a plain close × (no dirty awareness) until the chunk lands.
  return (
    <Suspense
      fallback={
        <button
          onClick={(e) => {
            e.stopPropagation();
            props.onClose();
          }}
          className="flex size-4 items-center justify-center rounded-sm text-fg-muted opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
          aria-label={`Close ${props.label}`}
        >
          ×
        </button>
      }
    >
      <CloseInner {...props} />
    </Suspense>
  );
}
