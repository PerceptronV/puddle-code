<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed

- The **resume banner** (interrupted/exited sessions) and the **ports strip** now sit at the **bottom** of the editor view instead of the top.

### Fixed

- The **Settings** dialog no longer fails to open on first click (URL updated to `#settings/…` but nothing showed until a reload). The open state is a module variable subscribed to via `useState`/`useEffect` (a `useSyncExternalStore` version did not re-render the gate), and the dialog chunk is preloaded so opening never suspends into a blank frame. The URL stays a deep-link mirror, resynced on back/forward.
- Clicking a session tab from **another project** in the editor now switches to that session's own project (the URL and left file tree follow it), instead of keeping the current project and showing an empty tree.
- A stored profile id that no longer matches a real profile (e.g. after a daemon change) now falls back to the **profile picker** instead of rendering a homepage bound to a nameless, non-existent profile.
