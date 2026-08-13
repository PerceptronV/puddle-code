<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [0.0.43] — 2026-08-13

### Added

- Open any daemon-host file or directory from a typed path in the command palette.

### Fixed

- Make short file tabs shrink to their visible labels without counting hidden hover-control spacing.
- Compare symlinked editor files with their resolved target at `HEAD` instead of the link's target-path blob.
- Prompt for passwords, key passphrases, host confirmation, and 2FA when the desktop app connects or reconnects to an SSH host.
- Fit the macOS desktop cockpit flush to the work area while retaining native rounded corners and shadow.
- Make the close control in Monaco's inline dirty-diff viewer respond reliably to pointer input.
