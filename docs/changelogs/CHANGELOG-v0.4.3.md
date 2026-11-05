<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.4.3] — 2026-11-05

### Cockpit

- Defer terminal resize requests until attachment replay and keep ended or historical terminals readable without spurious connection errors.
- Centre collapsed project-island labels when no sessions are listed.
- Align the remote web app with cockpit islands, inset editor surfaces, action trays and separated session groups, retaining touch targets and overlay shadows.

### Runtime

- Detect idle Codex conversations from the rendered footer when native status signals are unavailable, preventing partial terminal redraws from leaving them marked busy.
- Preserve the launch environment for provider version checks and Codex conversation-sync sidecars under macOS and Linux service managers.
