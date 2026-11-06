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

- Hold ⌘⌥/ (Ctrl+Alt+/ on Windows/Linux) to blur the workspace and glance at the host icon and name; release to return immediately.
- Customise each host’s icon and accent per profile, independently of Settings Sync; choose from 63 host-specific icons and the shared colour palette, with a coherent accent palette across text, controls, surfaces, borders and selections.

#### Changed

- Coalesce custom cursor movement per frame and reuse hover-role/style checks while preserving theme, font and target changes.
- Reduce memory held by long-inactive terminals while preserving their local transcripts, scroll position and offline copy; keep recent switches and unsupported terminal states warm.
- Share session lifecycle eligibility across mobile and desktop; explain unavailable resumes on mobile while keeping live sessions stoppable.
- Support selective component releases and manifest-pinned bootstrap; notify only for newly published host components, and reject explicitly requested skipped versions.
- Skip unchanged terminal rich-output projections, resolve tab sessions once, and share delayed blob-download cleanup for worktree downloads.
- Bound memory retained while streaming local or SSH logs, preserving complete output delivery and normal command capture.

#### Fixed

- Handle cancelled word highlighting and diff replies for disposed editor models during workspace transitions.

- Fit collapsed project abbreviations to the rail at the largest readable size, without ellipses.
- Avoid full-screen terminal redraws for cursor-only synchronised updates while preserving buffered output and the terminal's refresh timeout.
- Improve compact project-rail label sizing and vertical spacing; align selection and hover fills during dialogue scaling, and dismiss tab actions after pointer exit without losing keyboard access.
- Keep PDF zoom controls over the visible document instead of below its viewport; allow overlay trays to override their default positioning.

### Daemon

#### Changed

- Share eager compilation dependency watches and bounded asynchronous stats across targets; verify missed events less often with healthy watches and retire unobserved targets sooner.

- Protocol 26.3: acknowledge unchanged notebook execution revisions without resending outputs; back off idle and unfocused observation while preserving cross-window discovery and full reconnect snapshots.
- Stream uploads through bounded private staging with actual-byte limits, enumerate file trees asynchronously, and stop bounded directory downloads on cancellation.
- Bound Claude reference discovery to transcript prefixes and stream asynchronous usage reads, preserving totals across file replacement, truncation and partial writes.
- Share pending terminal snapshots at the same input boundary, preserving per-reader memory admission, fresh replay and durable checkpoint behaviour.
- Batch native conversation ingestion, avoid rewriting unchanged metadata, and read Codex file timestamps asynchronously while retaining complete discovery and missing-file confirmation.
- Resolve daemon and runtime updates independently from a release manifest, preserving existing pins and legacy catalogue readers.
- Publish changed notebook cells without repeatedly serialising every completed cell; preserve shared display updates, output clearing and cancellation.

#### Fixed

- Avoid writing conversation presence twice during one catalogue scan, preserving newer lifecycle observations and two-scan deletion confirmation.
- Avoid scanning the owning Git repository twice during repository discovery.
