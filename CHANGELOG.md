<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Fixed

- The workspace no longer **blinks on every session or project switch**: the routed view's error boundary was keyed by pathname, which remounted the whole workspace on each navigation — ui-state reloaded behind the loading gate and every terminal and editor was rebuilt. It now resets on navigation without remounting (measured in a real browser: the terminal DOM and the pane tree survive a switch, and the "…" gate no longer appears).
- **Source ⇄ preview is per tab.** The same file open in two panes flipped both tabs at once, so source-beside-preview was impossible; the toggle now rewrites only the pane it was clicked in. Both views still share one editor buffer, so the preview tracks the source pane's unsaved edits.
- Under the macOS desktop shell, **full-screen no longer keeps the title-bar inset** for traffic lights macOS has hidden: the host name moves to the left edge and the bar returns to its normal height, restoring both when leaving full-screen.
