import { Suspense, lazy } from 'react';

/**
 * Code-split history view: it renders Monaco `<Editor>`/`<DiffEditor>`
 * instances (all private, read-only models — see HistoryFileContent), so —
 * like `LazyDiffView` for the diff view — it must sit behind the lazy
 * boundary and never on the eager bundle. Workspace imports THIS wrapper,
 * never `HistoryView` directly; `HistoryView`'s own first import is
 * `../editor/monaco-setup`, which keeps Monaco off the CDN (see that file).
 */
const Inner = lazy(() =>
  import('./HistoryView').then((module) => ({ default: module.HistoryView })),
);

export function LazyHistoryView({ session }: { session: string }) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center bg-ground text-xs text-fg-muted">
          Loading history…
        </div>
      }
    >
      <Inner session={session} />
    </Suspense>
  );
}
