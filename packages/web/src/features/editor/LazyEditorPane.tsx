import { Suspense, lazy } from 'react';
import type { EditorZoneProps } from './EditorZone';

/**
 * Code-split editor zone: monaco, the buffer store, and the editor-sync/draft
 * machinery all live in this chunk and load on first use (mirrors
 * `LazyTerminal.tsx` for xterm). Workspace imports THIS eager-safe wrapper —
 * never `EditorZone` directly — so nothing behind the lazy boundary sits on
 * the eager bundle. `EditorZone`'s own first import is `./monaco-setup`, which
 * is what keeps Monaco off the CDN (see that file).
 */
const Inner = lazy(() => import('./EditorZone').then((module) => ({ default: module.EditorZone })));

export function LazyEditorPane(props: EditorZoneProps) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center bg-surface text-xs text-fg-muted">
          Loading editor…
        </div>
      }
    >
      <Inner {...props} />
    </Suspense>
  );
}
