<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.4.11] — 2026-11-06

### Cockpit

#### Added

- Add the opt-in Ripple reading view for agent terminals, with shared Markdown, Mermaid and LaTeX rendering, browser text selection and native CLI controls; choose its default in Appearance or override it per session.
- Add Linux arm64 AppImage releases, built on a native arm64 runner alongside Linux x64 and macOS arm64. Linux packaging verifies extraction, bundled application contents and executable architecture before publication.

#### Changed

- Group session menus into lifecycle, runtime/renderer/environment, and account/worktree/editor actions; label the runtime inspector “Runtime”.

#### Fixed

- Unify accented editor and terminal backgrounds with sidebar surfaces, using a slightly deeper light tint and lighter dark tint while preserving tab contrast and the default theme.
- Keep existing-tab and pane activation immediate without fading tabs or content, including across projects in a shared layout.
- Preserve the content fade when closing the active tab while keeping ordinary tab switches immediate.

### Daemon

#### Fixed

- Automatically repair legacy supervisor marker write permissions during authorised daemon-update staging after checking ownership, unchanged file identity and the live service; keep status and preflight read-only and retain specific blockers and manual repair guidance when automatic repair is unsafe.
