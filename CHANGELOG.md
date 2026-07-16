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

- The **Settings** dialog now opens on click. The open state was tied to `window.location.hash`, and setting the fragment inside the click handler stopped the open from triggering its own re-render (any later, unrelated re-render then revealed the dialog). It is now plain React state fanned out to the gate via a tiny pub-sub — nothing touches the URL — so the dialog opens immediately. (Trade-off: settings sections are no longer deep-linkable via `#settings/<section>`.)
- Clicking a session tab from **another project** in the editor now switches to that session's own project (the URL and left file tree follow it), instead of keeping the current project and showing an empty tree.
- A stored profile id that no longer matches a real profile (e.g. after a daemon change) now falls back to the **profile picker** instead of rendering a homepage bound to a nameless, non-existent profile.
