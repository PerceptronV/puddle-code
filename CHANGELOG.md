<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]


### Cockpit

- Defer terminal resize requests until attachment replay and keep ended or historical terminals readable without spurious connection errors.

- Centre collapsed project-island labels when no sessions are listed.

- Align the remote web app with cockpit islands, inset editor surfaces, action trays and separated session groups, retaining touch targets and overlay shadows.

### Runtime

- Preserve the launch environment for provider version checks and Codex conversation-sync sidecars under macOS and Linux service managers.
