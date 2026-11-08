<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Frontend

#### Changed

- Enabling Ripple starts its handle at the bottom with output and input covered; disabling it starts at the top for full CLI. Manual placement remains available on desktop and mobile.
- Use frontend terminology throughout the application, documentation and future releases while retaining compatibility with published versions.

#### Fixed

- Cover the native terminal's leftmost column in Ripple so prompt markers and input do not appear twice when the handle is dragged to the bottom, on desktop and mobile.
- Refresh cached website favicons, installed web app icons and notification icons to use the new Puddle logo set.

### Daemon

#### Added

- Add preparatory huddle document validation and bounded source discovery for independent project definitions, including typed settings and bounded feedback graphs; runtime and UI enablement remain pending.
- Persist huddle session identities per project/worktree/definition and record their owners without terminal segments. Application protocol 27.0 requires a coordinated frontend/daemon update for the third session kind; huddle creation and lifecycle UI remain pending. Existing agent/terminal runtime protocol 1.1 is unchanged.
- Adopt surviving huddle owners alongside ordinary runtimes, update session status from bounded owner notifications, and retain unresolved resources after a crash. Daemon replacement observes completed work without replay; public creation and lifecycle UI remain pending.
- Check retained huddle contracts before selected-daemon startup, preserving read-only inspection and allowing compatible controllers to inspect interrupted huddles without replaying their work.
- Extend host runtime removal and release collection to huddles, rechecking Stop impact and retaining pinned software until clean shutdown and the existing later-boot barrier are proven.
- Preserve huddle identity and contract requirements through host-update preflight, shutdown checkpoints and fresh adoption/recovery. Candidate daemons must explicitly advertise huddle adoption support; existing agent/terminal metadata stays compatible.
- Add pinned huddle launch admission and exact-owner lifecycle controls, with durable Stop intent and ordinary session kill/archive integration. New owners start inactive; public huddle creation and Start/Run UI remain pending.

### Runtime

#### Added

- Define huddle event/readout contracts and an internal node execution boundary with validated ports, immutable inputs and acknowledged emissions, ahead of independent owner integration.
- Add a private huddle execution ledger with atomic trigger cursors, node routing, retained budgets and outcome reservations; preserve consumed operations through process loss without redispatch.
- Add durable huddle graph routing with correlated joins, explicit event fan-out and bounded coder/reviewer feedback; keep worker/service integration pending.
- Add isolated huddle script workers with captured multi-file imports, shared puddlang agent calls, bounded transport and cancellation; include the helper modules and smoke check in host archives.
- Persist immutable huddle revisions and exact activation bindings, and schedule manual graphs through isolated workers with bounded feedback, durable results and cancellation; independent owner-service integration remains pending.
- Compose an independent huddle owner with authenticated private control, shared ownership/memory admission and controllerless script completion; keep production creation gated pending capability, maintenance and daemon integration.
- Declare huddle runtime contracts in separate passive release metadata, validate pinned helpers/selection before admission, and verify required capabilities during owner startup/adoption without changing ordinary agent runtime selection.
