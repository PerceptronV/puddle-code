<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.5.10] — 2026-11-22

### Frontend

#### Fixed

- Show current runtime takeover blockers during host recovery and explain verification, continuation and separate session interruption.

### Daemon

#### Fixed

- Block daemon replacement when existing runtimes report unsaved state, expose bounded recovery diagnostics through existing update reviews, and show affected runtime ids in CLI status without relaxing completion checks or replaying actions.
