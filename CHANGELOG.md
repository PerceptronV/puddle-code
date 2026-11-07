<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Cockpit

#### Added

- Bring Ripple to mobile with a shared Settings switch, a larger touch divider and swipe-through CLI history, retaining the phone composer and terminal keys.

#### Fixed

- Keep the live development preview running when a browser WebSocket disconnects with a broken pipe.

- Keep Ripple’s divider available in every agent session, with dragging from full CLI to full reading view. Remove the Renderer menu and move Ripple’s appearance switch above reduced motion; switching it restores the corresponding starting position.
- Use themed surfaces for Ripple prompt bubbles, retaining inline text colours and emphasis. Keep padding legible after theme changes when a CLI retains a stale neutral background, preserving explicit terminal colour pairs and coloured highlights outside prompts.

- Replace inline LaTeX icon overlays with underlined, directly clickable preview/source text in Ripple and the native terminal, defaulting to preview and retaining keyboard access and source copying.
- Remove Ripple’s heading, toolbar and floating latest-output button; mark its draggable native CLI boundary with a thin divider.

- Keep surrounding Ripple code and prose in place while Codex’s Working spinner changes, and preserve the first Markdown list marker in styled user prompts.

- Map Ripple text clicks to original terminal cells instead of recognising Codex disclosure labels; preserve native pinned-prompt navigation without absorbing following diffs into the prompt bubble, including short pinned prompts without an ellipsis.
- Keep Codex’s Working indicator native, leave breathing room above CLI controls, account for partial terminal rows, preserve numbered diff line breaks and hide Ripple’s overflow scrollbars while retaining scrolling.
- Stabilise Codex’s animated Working row and let dividers near the input follow multiline draft expansion and contraction, including after reload and resize.
