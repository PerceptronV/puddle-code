<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Show the recognised foreground agent's icon in terminal sessions, restoring the terminal icon when it exits or is suspended; add the optional `detected_agent_type` hint in daemon/cockpit protocol **22.1** (remote protocol remains **3**).

### Fixed

- Deliver desktop notifications through the native shell, report failures and provide a test button instead of assuming that desktop permission is granted.
- Allow notifications while Puddle is focused by default, with a background-only preference in daemon/cockpit protocol **22.2**.
- Realign editor bracket highlights, selections and carets when the self-hosted font finishes loading.
- Refresh eager compilation PDFs when the completed result advances, so polling during a build cannot reload the previous output and skip the finished PDF.
