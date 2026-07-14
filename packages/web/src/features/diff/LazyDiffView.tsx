import { Suspense, lazy } from 'react';

/**
 * Code-split diff view: it renders Monaco `<DiffEditor>`s and binds the shared
 * buffer-store models, so — like `LazyEditorPane` for the editor zone — it must
 * sit behind the lazy boundary and never on the eager bundle. Workspace imports
 * THIS wrapper, never `DiffView` directly; `DiffView`'s own first import is
 * `../editor/monaco-setup`, which keeps Monaco off the CDN (see that file).
 */
const Inner = lazy(() => import('./DiffView').then((module) => ({ default: module.DiffView })));

export function LazyDiffView({ session }: { session: string }) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center bg-ground text-xs text-fg-muted">
          Loading diff…
        </div>
      }
    >
      <Inner session={session} />
    </Suspense>
  );
}
