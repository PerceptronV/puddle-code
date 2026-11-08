# Dependency patches

`monaco-editor@0.55.1.patch` fixes disposal failures exposed by workspace and native
window-transfer regressions:

- Word-highlighter delays reject when cancelled. Route all three promises through
  Monaco’s existing cancellation-aware error handler; unexpected errors still surface.
- A diff worker may reply after its original model is disposed, before the
  view-model cancellation flag is set. Repeat the existing disposed-model check
  after the await and return the same early-exit result as cancellation. Missing
  results for live models still throw.
- The global hover delegate factory must use the standalone renderer's service
  container. Capturing a diff editor's child container leaves it pointing at
  disposed services when that view closes; later suggest/hover construction and
  sibling diff cleanup can crash the workspace. The native source/locked-preview
  detach/dock regression covers the failure and continued editor use.

Reassess this patch when upgrading Monaco. It is applied by pnpm, including CI
and production builds; no application-wide rejection filter is installed.
