# Dependency patches

`monaco-editor@0.55.1.patch` fixes two disposal races exposed by the full workspace
browser regression (`workspace-transitions.mjs`):

- Word-highlighter delays reject when cancelled. Route all three promises through
  Monaco’s existing cancellation-aware error handler; unexpected errors still surface.
- A diff worker may reply after its original model is disposed, before the
  view-model cancellation flag is set. Repeat the existing disposed-model check
  after the await and return the same early-exit result as cancellation. Missing
  results for live models still throw.

Reassess this patch when upgrading Monaco. It is applied by pnpm, including CI
and production builds; no application-wide rejection filter is installed.
